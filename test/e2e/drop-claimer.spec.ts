import { expect, test } from '@playwright/test';

import { DropClaimer } from '../../src/browser/DropClaimer.js';

test.describe('DropClaimer Twitch Apollo integration', () => {
  test('只領取已達標且符合前置條件的 drops', async ({ page }) => {
    await page.setContent('<div id="root"></div>');
    await page.evaluate(() => {
      const mutationInputs: string[] = [];
      const client = {
        async query() {
          return {
            data: {
              currentUser: {
                id: 'user-1',
                inventory: {
                  dropCampaignsInProgress: [
                    {
                      id: 'campaign-1',
                      timeBasedDrops: [
                        {
                          id: 'drop-explicit',
                          requiredMinutesWatched: 15,
                          self: {
                            isClaimed: false,
                            currentMinutesWatched: 15,
                            dropInstanceID: 'instance-explicit',
                            hasPreconditionsMet: true,
                          },
                        },
                        {
                          id: 'drop-fallback',
                          requiredMinutesWatched: 30,
                          self: {
                            isClaimed: false,
                            currentMinutesWatched: 45,
                            dropInstanceID: null,
                            hasPreconditionsMet: true,
                          },
                        },
                        {
                          id: 'drop-incomplete',
                          requiredMinutesWatched: 60,
                          self: {
                            isClaimed: false,
                            currentMinutesWatched: 59,
                            dropInstanceID: 'instance-incomplete',
                            hasPreconditionsMet: true,
                          },
                        },
                        {
                          id: 'drop-claimed',
                          requiredMinutesWatched: 5,
                          self: {
                            isClaimed: true,
                            currentMinutesWatched: 5,
                            dropInstanceID: 'instance-claimed',
                            hasPreconditionsMet: true,
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          };
        },
        async mutate(options: {
          variables: { input: { dropInstanceID: string } };
        }) {
          mutationInputs.push(options.variables.input.dropInstanceID);
          return { data: { claimDropRewards: { status: 'ELIGIBLE_FOR_ALL' } } };
        },
      };
      const root = document.querySelector('#root');
      if (root === null) {
        throw new Error('Missing React root');
      }
      Object.assign(root, {
        __reactContainer$watchdog: {
          pendingProps: { value: { client } },
        },
      });
      Object.assign(globalThis, { __dropMutationInputs: mutationInputs });
    });

    const result = await new DropClaimer().claimIfAvailable(page);

    expect(result).toMatchObject({
      status: 'claimed',
      claimedCount: 2,
      failedCount: 0,
    });
    await expect(
      page.evaluate(
        () => (globalThis as unknown as {
          __dropMutationInputs: string[];
        }).__dropMutationInputs,
      ),
    ).resolves.toEqual([
      'instance-explicit',
      'user-1#campaign-1#drop-fallback',
    ]);
  });
});
