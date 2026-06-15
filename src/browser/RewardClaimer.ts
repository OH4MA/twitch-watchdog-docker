import type { Locator, Page } from 'playwright';

import {
  LOG_EVENTS,
  redactSensitiveString,
  type LogFields,
} from '../logging/index.js';

export const COMMUNITY_POINTS_CLAIM_BUTTON_SELECTOR =
  [
    '[data-test-selector="community-points-claim-button"]',
    '.claimable-bonus__icon',
  ].join(', ');
export const COMMUNITY_POINTS_SUMMARY_SELECTOR =
  '[data-test-selector="community-points-summary"]';
export const REWARD_BUTTON_LIKE_SELECTOR =
  'button:not([type="submit"]), [role="button"], input[type="button"]';
export const REWARD_CLAIM_COOLDOWN_MS = 60_000;

export type RewardClaimResult =
  | { status: 'claimed'; channel: string; claimedAt: string }
  | { status: 'not_found'; channel: string; checkedAt: string }
  | {
      status: 'click_failed';
      channel: string;
      checkedAt: string;
      error: string;
    };

export interface RewardClaimerLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export type RewardClaimerClock =
  | (() => Date)
  | {
      now(): Date;
    };

export interface RewardClaimerOptions {
  readonly logger?: RewardClaimerLogger;
  readonly clock?: RewardClaimerClock;
  readonly onResult?: RewardClaimObserver;
}

export type RewardClaimObserver = (
  result: RewardClaimResult,
) => void | Promise<void>;

export interface RewardClaimer {
  claimIfAvailable(page: Page, channel: string): Promise<RewardClaimResult>;
}

const NOOP_LOGGER: RewardClaimerLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export const RewardClaimer = class RewardClaimerImplementation
  implements RewardClaimer
{
  private readonly logger: RewardClaimerLogger;
  private readonly now: () => Date;
  private readonly onResult: RewardClaimObserver | undefined;
  private readonly lastClaimedAtByChannel = new Map<string, number>();

  public constructor(options: RewardClaimerOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = resolveClock(options.clock);
    this.onResult = options.onResult;
  }

  public async claimIfAvailable(
    page: Page,
    channel: string,
  ): Promise<RewardClaimResult> {
    const checkedAt = this.now();
    const checkedAtIso = checkedAt.toISOString();

    if (this.isCoolingDown(channel, checkedAt.getTime())) {
      return {
        status: 'not_found',
        channel,
        checkedAt: checkedAtIso,
      };
    }

    let claimButton: Locator | null;
    try {
      claimButton = await findClaimButton(page);
    } catch (error: unknown) {
      return this.failedResult(channel, checkedAtIso, error);
    }

    if (claimButton === null) {
      return {
        status: 'not_found',
        channel,
        checkedAt: checkedAtIso,
      };
    }

    try {
      await claimButton.click();
    } catch (error: unknown) {
      return this.failedResult(channel, checkedAtIso, error);
    }

    const claimedAt = this.now();
    const claimedAtIso = claimedAt.toISOString();
    this.lastClaimedAtByChannel.set(
      normalizeChannel(channel),
      claimedAt.getTime(),
    );
    safeLog(this.logger, 'info', LOG_EVENTS.REWARD_CLAIMED, {
      channel,
      claimedAt: claimedAtIso,
    });

    const result: RewardClaimResult = {
      status: 'claimed',
      channel,
      claimedAt: claimedAtIso,
    };
    this.notifyResult(result);
    return result;
  }

  private isCoolingDown(channel: string, checkedAt: number): boolean {
    const lastClaimedAt = this.lastClaimedAtByChannel.get(
      normalizeChannel(channel),
    );

    return (
      lastClaimedAt !== undefined &&
      checkedAt - lastClaimedAt < REWARD_CLAIM_COOLDOWN_MS
    );
  }

  private failedResult(
    channel: string,
    checkedAt: string,
    error: unknown,
  ): RewardClaimResult {
    const safeError = safeErrorMessage(error);
    safeLog(this.logger, 'warn', LOG_EVENTS.REWARD_CLAIM_FAILED, {
      channel,
      checkedAt,
      error: safeError,
    });

    const result: RewardClaimResult = {
      status: 'click_failed',
      channel,
      checkedAt,
      error: safeError,
    };
    this.notifyResult(result);
    return result;
  }

  private notifyResult(result: RewardClaimResult): void {
    try {
      void Promise.resolve(this.onResult?.(result)).catch(() => {
        safeLog(this.logger, 'warn', 'reward_notification_failed', {
          channel: result.channel,
        });
      });
    } catch {
      safeLog(this.logger, 'warn', 'reward_notification_failed', {
        channel: result.channel,
      });
    }
  }
};

async function findClaimButton(page: Page): Promise<Locator | null> {
  const primaryCandidates = page.locator(
    COMMUNITY_POINTS_CLAIM_BUTTON_SELECTOR,
  );
  const primaryCount = await primaryCandidates.count();
  const primary = await firstClickable(primaryCandidates, primaryCount);

  if (primary !== null || primaryCount > 0) {
    return primary;
  }

  const summaries = page.locator(COMMUNITY_POINTS_SUMMARY_SELECTOR);
  const summaryCount = await summaries.count();
  let fallback: Locator | null = null;

  for (let index = 0; index < summaryCount; index += 1) {
    const candidates = summaries
      .nth(index)
      .locator(REWARD_BUTTON_LIKE_SELECTOR);
    const candidateCount = await candidates.count();
    for (
      let candidateIndex = 0;
      candidateIndex < candidateCount;
      candidateIndex += 1
    ) {
      const candidate = candidates.nth(candidateIndex);
      if (
        (await candidate.isVisible()) &&
        !(await candidate.isDisabled()) &&
        (await candidate.getAttribute('aria-label')) === null
      ) {
        if (fallback !== null) {
          return null;
        }
        fallback = candidate;
      }
    }
  }

  return fallback;
}

async function firstClickable(
  candidates: Locator,
  count: number,
): Promise<Locator | null> {
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);

    if (
      (await candidate.isVisible()) &&
      !(await candidate.isDisabled()) &&
      !isDestructiveButton(await candidate.getAttribute('class'))
    ) {
      return candidate;
    }
  }

  return null;
}

function isDestructiveButton(className: string | null): boolean {
  return className?.includes('ScCoreButtonDestructive') ?? false;
}

function resolveClock(clock: RewardClaimerClock | undefined): () => Date {
  if (clock === undefined) {
    return () => new Date();
  }

  if (typeof clock === 'function') {
    return clock;
  }

  return () => clock.now();
}

function normalizeChannel(channel: string): string {
  return channel.trim().toLocaleLowerCase('en-US');
}

function safeErrorMessage(error: unknown): string {
  let message = 'Unknown reward claim failure';

  try {
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error !== undefined && error !== null) {
      message = String(error);
    }
  } catch {
    message = 'Unserializable reward claim failure';
  }

  return redactSensitiveString(message);
}

function safeLog(
  logger: RewardClaimerLogger,
  level: 'info' | 'warn',
  event: string,
  fields: LogFields,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Logging must not turn a recoverable reward attempt into a session error.
  }
}
