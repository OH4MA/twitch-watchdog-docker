import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  DROP_CLAIM_CHECK_INTERVAL_MS,
  DropClaimer,
  type DropClaimerLogger,
} from '../../src/browser/DropClaimer.js';
import { REDACTED_VALUE } from '../../src/logging/index.js';

const START_TIME = new Date('2026-06-15T08:00:00.000Z');

function createPage(
  result: unknown,
  error?: Error,
): {
  readonly page: Page;
  readonly evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = error === undefined
    ? vi.fn(async () => result)
    : vi.fn(async () => {
        throw error;
      });
  return {
    page: { evaluate } as unknown as Page,
    evaluate,
  };
}

function createLogger(): {
  readonly logger: DropClaimerLogger;
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const warn = vi.fn();
  return { logger: { info, warn }, info, warn };
}

describe('DropClaimer', () => {
  it('記錄已領取數量並通知 observer', async () => {
    const page = createPage({
      eligibleCount: 3,
      claimedCount: 2,
      failedCount: 1,
    });
    const logs = createLogger();
    const onResult = vi.fn();
    const claimer = new DropClaimer({
      logger: logs.logger,
      now: () => START_TIME,
      onResult,
    });

    const result = await claimer.claimIfAvailable(page.page);

    expect(result).toEqual({
      status: 'claimed',
      claimedAt: START_TIME.toISOString(),
      claimedCount: 2,
      failedCount: 1,
    });
    expect(logs.info).toHaveBeenCalledWith('drop_claimed', {
      claimedAt: START_TIME.toISOString(),
      claimedCount: 2,
      failedCount: 1,
    });
    expect(logs.warn).toHaveBeenCalledWith(
      'drop_claim_partial_failure',
      { claimedCount: 2, failedCount: 1 },
    );
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it('沒有符合資格的 drop 時回傳 not_found', async () => {
    const page = createPage({
      eligibleCount: 0,
      claimedCount: 0,
      failedCount: 0,
    });
    const claimer = new DropClaimer({ now: () => START_TIME });

    await expect(claimer.claimIfAvailable(page.page)).resolves.toEqual({
      status: 'not_found',
      checkedAt: START_TIME.toISOString(),
    });
  });

  it('頁面執行失敗時遮罩敏感資料且不向外拋出', async () => {
    const secret = 'drop-token-secret';
    const page = createPage(
      undefined,
      new Error(`access_token=${secret}`),
    );
    const logs = createLogger();
    const claimer = new DropClaimer({
      logger: logs.logger,
      now: () => START_TIME,
    });

    const result = await claimer.claimIfAvailable(page.page);

    expect(result.status).toBe('claim_failed');
    if (result.status !== 'claim_failed') {
      throw new Error('Expected claim_failed');
    }
    expect(result.error).toContain(REDACTED_VALUE);
    expect(result.error).not.toContain(secret);
    expect(logs.warn).toHaveBeenCalledWith(
      'drop_claim_failed',
      expect.objectContaining({ error: result.error }),
    );
  });

  it('所有 eligible claims 失敗時回傳 claim_failed', async () => {
    const page = createPage({
      eligibleCount: 2,
      claimedCount: 0,
      failedCount: 2,
    });
    const claimer = new DropClaimer({ now: () => START_TIME });

    await expect(claimer.claimIfAvailable(page.page)).resolves.toMatchObject({
      status: 'claim_failed',
    });
  });

  it('跨頻道共用 60 秒檢查冷卻', async () => {
    let now = START_TIME.getTime();
    const firstPage = createPage({
      eligibleCount: 0,
      claimedCount: 0,
      failedCount: 0,
    });
    const secondPage = createPage({
      eligibleCount: 0,
      claimedCount: 0,
      failedCount: 0,
    });
    const claimer = new DropClaimer({
      now: () => new Date(now),
    });

    await claimer.claimIfAvailable(firstPage.page);
    now += DROP_CLAIM_CHECK_INTERVAL_MS - 1;
    await claimer.claimIfAvailable(secondPage.page);

    expect(firstPage.evaluate).toHaveBeenCalledOnce();
    expect(secondPage.evaluate).not.toHaveBeenCalled();

    now += 1;
    await claimer.claimIfAvailable(secondPage.page);
    expect(secondPage.evaluate).toHaveBeenCalledOnce();
  });

  it('併發呼叫共用同一個 claim flight', async () => {
    let resolveEvaluation:
      | ((value: {
          eligibleCount: number;
          claimedCount: number;
          failedCount: number;
        }) => void)
      | undefined;
    const evaluation = new Promise<{
      eligibleCount: number;
      claimedCount: number;
      failedCount: number;
    }>((resolve) => {
      resolveEvaluation = resolve;
    });
    const evaluate = vi.fn(() => evaluation);
    const page = { evaluate } as unknown as Page;
    const claimer = new DropClaimer({ now: () => START_TIME });

    const first = claimer.claimIfAvailable(page);
    const second = claimer.claimIfAvailable(page);
    resolveEvaluation?.({
      eligibleCount: 0,
      claimedCount: 0,
      failedCount: 0,
    });

    expect(await first).toEqual(await second);
    expect(evaluate).toHaveBeenCalledOnce();
  });
});
