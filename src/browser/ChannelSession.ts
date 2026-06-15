import type { Locator, Page } from 'playwright';

import type { AppConfig } from '../config/AppConfig.js';
import {
  LOG_EVENTS,
  redactSensitiveString,
  type LogFields,
  type Logger,
} from '../logging/index.js';
import type { BrowserManager } from './BrowserManager.js';
import type { DropClaimer } from './DropClaimer.js';
import type {
  RewardClaimer,
  RewardClaimResult,
} from './RewardClaimer.js';

const CHANNEL_PATTERN = /^[A-Za-z0-9_]{1,25}$/u;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3;

export const CHANNEL_HEALTH_SELECTORS = Object.freeze({
  loginRequired: [
    '[data-test-selector="login-required"]',
    '[data-a-target="login-button"]',
    '[data-channel-health="login-required"]',
  ].join(', '),
  liveContent: [
    '[data-a-target="video-player"]',
    '[data-test-selector="video-player"]',
    '[data-channel-health="live"]',
  ].join(', '),
  error: [
    '[data-test-selector="error-page"]',
    '[data-a-target="player-error-message"]',
    '[data-channel-health="error"]',
  ].join(', '),
  offline: [
    '[data-test-selector="offline-page"]',
    '[data-a-target="offline-channel-main-content"]',
    '[data-channel-health="offline"]',
  ].join(', '),
});

export type ChannelSessionState =
  | 'starting'
  | 'watching'
  | 'recovering'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type ChannelHealthFailureReason =
  | 'not_started'
  | 'page_closed'
  | 'url_mismatch'
  | 'login_required'
  | 'error_page'
  | 'offline'
  | 'live_content_missing'
  | 'health_check_error';

export type ChannelHealthResult =
  | { readonly healthy: true; readonly reason: 'live' }
  | {
      readonly healthy: false;
      readonly reason: ChannelHealthFailureReason;
      readonly error?: string;
    };

export interface ChannelSession {
  readonly channel: string;
  readonly state: ChannelSessionState;
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
  checkHealth(): Promise<ChannelHealthResult>;
  tickRewardClaim(): Promise<RewardClaimResult>;
  captureScreenshot(): Promise<Buffer>;
}

export interface ChannelSessionFactory {
  create(channel: string): ChannelSession;
}

export type ChannelSessionLogger = Pick<
  Logger,
  'debug' | 'info' | 'warn' | 'error'
>;

export type ChannelHealthEvaluator = (
  page: Page,
  targetUrl: string,
) => Promise<ChannelHealthResult>;

export type ChannelSessionInvalidationObserver = (
  channel: string,
  reason: 'health_failure_threshold',
) => Promise<void> | void;

export interface DefaultChannelSessionOptions {
  readonly channel: string;
  readonly config: Pick<AppConfig, 'channels' | 'browser'>;
  readonly browserManager: BrowserManager;
  readonly rewardClaimer: RewardClaimer;
  readonly dropClaimer?: Pick<DropClaimer, 'claimIfAvailable'>;
  readonly logger?: ChannelSessionLogger;
  readonly healthFailureThreshold?: number;
  readonly healthEvaluator?: ChannelHealthEvaluator;
  readonly onInvalidated?: ChannelSessionInvalidationObserver;
  readonly now?: () => Date;
}

export interface DefaultChannelSessionFactoryOptions {
  readonly config: Pick<AppConfig, 'channels' | 'browser'>;
  readonly browserManager: BrowserManager;
  readonly rewardClaimer: RewardClaimer;
  readonly dropClaimer?: Pick<DropClaimer, 'claimIfAvailable'>;
  readonly logger?: ChannelSessionLogger;
  readonly healthFailureThreshold?: number;
  readonly healthEvaluator?: ChannelHealthEvaluator;
  readonly onInvalidated?: ChannelSessionInvalidationObserver;
  readonly now?: () => Date;
}

const NOOP_LOGGER: ChannelSessionLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

export class DefaultChannelSessionFactory implements ChannelSessionFactory {
  public constructor(
    private readonly options: DefaultChannelSessionFactoryOptions,
  ) {}

  public create(channel: string): ChannelSession {
    return new DefaultChannelSession({
      ...this.options,
      channel,
    });
  }
}

export class DefaultChannelSession implements ChannelSession {
  public readonly channel: string;

  private readonly targetUrl: string;
  private readonly browserManager: BrowserManager;
  private readonly rewardClaimer: RewardClaimer;
  private readonly dropClaimer:
    | Pick<DropClaimer, 'claimIfAvailable'>
    | undefined;
  private readonly logger: ChannelSessionLogger;
  private readonly healthFailureThreshold: number;
  private readonly healthEvaluator: ChannelHealthEvaluator;
  private readonly onInvalidated:
    | ChannelSessionInvalidationObserver
    | undefined;
  private readonly now: () => Date;

  private currentState: ChannelSessionState = 'stopped';
  private page: Page | undefined;
  private consecutiveHealthFailures = 0;
  private healthTimer: NodeJS.Timeout | undefined;
  private rewardTimer: NodeJS.Timeout | undefined;
  private healthFlight: Promise<ChannelHealthResult> | undefined;
  private rewardFlight: Promise<RewardClaimResult> | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly options: DefaultChannelSessionOptions,
  ) {
    validateConfiguredChannel(options.channel, options.config.channels);
    this.channel = options.channel;
    this.targetUrl = createChannelUrl(options.channel);
    this.browserManager = options.browserManager;
    this.rewardClaimer = options.rewardClaimer;
    this.dropClaimer = options.dropClaimer;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.healthFailureThreshold = positiveInteger(
      options.healthFailureThreshold,
      DEFAULT_HEALTH_FAILURE_THRESHOLD,
    );
    this.healthEvaluator =
      options.healthEvaluator ?? evaluateChannelHealth;
    this.onInvalidated = options.onInvalidated;
    this.now = options.now ?? (() => new Date());
  }

  public get state(): ChannelSessionState {
    return this.currentState;
  }

  public start(): Promise<void> {
    return this.runLifecycle(async () => {
      if (
        this.currentState === 'starting' ||
        this.currentState === 'watching' ||
        this.currentState === 'recovering' ||
        this.currentState === 'failed'
      ) {
        return;
      }

      this.currentState = 'starting';
      this.consecutiveHealthFailures = 0;

      try {
        const page = await this.browserManager.createPage(this.channel);
        this.page = page;
        page.setDefaultNavigationTimeout(
          this.options.config.browser.navigationTimeoutMs,
        );
        await page.goto(this.targetUrl);
        if (!isExpectedChannelUrl(page.url(), this.targetUrl)) {
          throw new Error('頻道頁面導向非預期 Twitch URL');
        }

        this.currentState = 'watching';
        this.startTimers();
        safeLog(this.logger, 'info', LOG_EVENTS.WATCH_STARTED, {
          channel: this.channel,
          url: this.targetUrl,
        });
      } catch (error: unknown) {
        this.currentState = 'failed';
        this.clearTimers();
        this.page = undefined;
        await this.closePageForCleanup('start_failure');
        safeLog(this.logger, 'error', 'watch_start_failed', {
          channel: this.channel,
          error: safeErrorMessage(error),
        });
        throw error;
      }
    });
  }

  public stop(reason: string): Promise<void> {
    return this.runLifecycle(async () => {
      if (
        this.currentState === 'stopped' ||
        this.currentState === 'stopping'
      ) {
        return;
      }

      this.currentState = 'stopping';
      this.clearTimers();
      await this.waitForCurrentWork();
      this.page = undefined;

      try {
        await this.browserManager.closePage(this.channel);
      } catch (error: unknown) {
        safeLog(this.logger, 'warn', 'watch_stop_cleanup_failed', {
          channel: this.channel,
          reason,
          error: safeErrorMessage(error),
        });
      }

      this.currentState = 'stopped';
      this.consecutiveHealthFailures = 0;
      safeLog(this.logger, 'info', LOG_EVENTS.WATCH_STOPPED, {
        channel: this.channel,
        reason,
      });
    });
  }

  public checkHealth(): Promise<ChannelHealthResult> {
    const existingFlight = this.healthFlight;
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const flight = this.runHealthCheck();
    this.healthFlight = flight;
    flight.then(
      () => {
        if (this.healthFlight === flight) {
          this.healthFlight = undefined;
        }
      },
      () => {
        if (this.healthFlight === flight) {
          this.healthFlight = undefined;
        }
      },
    );
    return flight;
  }

  public tickRewardClaim(): Promise<RewardClaimResult> {
    const existingFlight = this.rewardFlight;
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const flight = this.runRewardClaim();
    this.rewardFlight = flight;
    flight.then(
      () => {
        if (this.rewardFlight === flight) {
          this.rewardFlight = undefined;
        }
      },
      () => {
        if (this.rewardFlight === flight) {
          this.rewardFlight = undefined;
        }
      },
    );
    return flight;
  }

  public async captureScreenshot(): Promise<Buffer> {
    const page = this.page;
    if (
      page === undefined ||
      page.isClosed() ||
      (this.currentState !== 'watching' &&
        this.currentState !== 'recovering')
    ) {
      throw new Error('頻道頁面目前無法截圖');
    }

    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
    });
    return Buffer.from(screenshot);
  }

  private async runHealthCheck(): Promise<ChannelHealthResult> {
    const page = this.page;
    if (page === undefined) {
      return {
        healthy: false,
        reason:
          this.currentState === 'failed' ? 'page_closed' : 'not_started',
      };
    }

    let result: ChannelHealthResult;
    try {
      result = await this.healthEvaluator(page, this.targetUrl);
    } catch (error: unknown) {
      result = {
        healthy: false,
        reason: 'health_check_error',
        error: safeErrorMessage(error),
      };
    }

    if (
      this.currentState === 'stopping' ||
      this.currentState === 'stopped'
    ) {
      return result;
    }

    if (result.healthy) {
      this.consecutiveHealthFailures = 0;
      this.currentState = 'watching';
      return result;
    }

    await this.handleHealthFailure(page, result);
    return result;
  }

  private async handleHealthFailure(
    page: Page,
    result: Extract<ChannelHealthResult, { healthy: false }>,
  ): Promise<void> {
    this.consecutiveHealthFailures += 1;
    safeLog(this.logger, 'warn', LOG_EVENTS.PAGE_HEALTH_FAILED, {
      channel: this.channel,
      reason: result.reason,
      consecutiveFailures: this.consecutiveHealthFailures,
      ...(result.error === undefined ? {} : { error: result.error }),
    });

    if (
      this.consecutiveHealthFailures >= this.healthFailureThreshold
    ) {
      await this.failSession();
      return;
    }

    this.currentState = 'recovering';
    if (this.consecutiveHealthFailures !== 1 || page.isClosed()) {
      return;
    }

    try {
      await page.reload();
    } catch (error: unknown) {
      safeLog(this.logger, 'warn', 'page_reload_failed', {
        channel: this.channel,
        error: safeErrorMessage(error),
      });
    }
  }

  private async failSession(): Promise<void> {
    this.currentState = 'failed';
    this.clearTimers();

    const rewardFlight = this.rewardFlight;
    if (rewardFlight !== undefined) {
      await Promise.allSettled([rewardFlight]);
    }

    this.page = undefined;
    await this.closePageForCleanup('health_failure_threshold');
    this.notifyInvalidated();
  }

  private async runRewardClaim(): Promise<RewardClaimResult> {
    const page = this.page;
    if (
      page === undefined ||
      page.isClosed() ||
      !isExpectedChannelUrl(page.url(), this.targetUrl) ||
      (this.currentState !== 'watching' &&
        this.currentState !== 'recovering')
    ) {
      return {
        status: 'not_found',
        channel: this.channel,
        checkedAt: this.now().toISOString(),
      };
    }

    try {
      const [rewardResult] = await Promise.all([
        this.rewardClaimer.claimIfAvailable(page, this.channel),
        this.claimDrops(page),
      ]);
      return rewardResult;
    } catch (error: unknown) {
      const checkedAt = this.now().toISOString();
      const safeError = safeErrorMessage(error);
      safeLog(this.logger, 'warn', LOG_EVENTS.REWARD_CLAIM_FAILED, {
        channel: this.channel,
        checkedAt,
        error: safeError,
      });
      return {
        status: 'click_failed',
        channel: this.channel,
        checkedAt,
        error: safeError,
      };
    }
  }

  private async claimDrops(page: Page): Promise<void> {
    try {
      await this.dropClaimer?.claimIfAvailable(page);
    } catch (error: unknown) {
      safeLog(this.logger, 'warn', 'drop_claim_unexpected_failure', {
        channel: this.channel,
        error: safeErrorMessage(error),
      });
    }
  }

  private startTimers(): void {
    if (
      this.healthTimer !== undefined ||
      this.rewardTimer !== undefined
    ) {
      return;
    }

    this.healthTimer = setInterval(() => {
      void this.checkHealth().catch((error: unknown) => {
        safeLog(this.logger, 'error', 'page_health_timer_failed', {
          channel: this.channel,
          error: safeErrorMessage(error),
        });
      });
    }, this.options.config.browser.pageHealthCheckIntervalSeconds * 1_000);

    this.rewardTimer = setInterval(() => {
      void this.tickRewardClaim().catch((error: unknown) => {
        safeLog(this.logger, 'error', 'reward_timer_failed', {
          channel: this.channel,
          error: safeErrorMessage(error),
        });
      });
    }, this.options.config.browser.rewardCheckIntervalSeconds * 1_000);
  }

  private clearTimers(): void {
    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    if (this.rewardTimer !== undefined) {
      clearInterval(this.rewardTimer);
      this.rewardTimer = undefined;
    }
  }

  private async waitForCurrentWork(): Promise<void> {
    const currentWork: Promise<unknown>[] = [];
    if (this.healthFlight !== undefined) {
      currentWork.push(this.healthFlight);
    }
    if (this.rewardFlight !== undefined) {
      currentWork.push(this.rewardFlight);
    }
    await Promise.allSettled(currentWork);
  }

  private async closePageForCleanup(reason: string): Promise<void> {
    try {
      await this.browserManager.closePage(this.channel);
    } catch (error: unknown) {
      safeLog(this.logger, 'warn', 'watch_page_cleanup_failed', {
        channel: this.channel,
        reason,
        error: safeErrorMessage(error),
      });
    }
  }

  private notifyInvalidated(): void {
    const observer = this.onInvalidated;
    if (observer === undefined) {
      return;
    }

    void Promise.resolve()
      .then(() => observer(this.channel, 'health_failure_threshold'))
      .catch((error: unknown) => {
        safeLog(this.logger, 'warn', 'session_invalidation_failed', {
          channel: this.channel,
          reason: 'health_failure_threshold',
          error: safeErrorMessage(error),
        });
      });
  }

  private async runLifecycle<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleTail;
    let release: (() => void) | undefined;
    this.lifecycleTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export function createChannelUrl(channel: string): string {
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error('Channel 必須是 1 到 25 字元的英數字或底線');
  }
  return `https://www.twitch.tv/${encodeURIComponent(channel)}`;
}

export async function evaluateChannelHealth(
  page: Page,
  targetUrl: string,
): Promise<ChannelHealthResult> {
  try {
    if (page.isClosed()) {
      return { healthy: false, reason: 'page_closed' };
    }

    if (!isExpectedChannelUrl(page.url(), targetUrl)) {
      return { healthy: false, reason: 'url_mismatch' };
    }

    if (
      await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.loginRequired))
    ) {
      return { healthy: false, reason: 'login_required' };
    }

    if (
      await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.error)) ||
      await hasUnsupportedPlayerError(page)
    ) {
      return { healthy: false, reason: 'error_page' };
    }

    if (await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.offline))) {
      return { healthy: false, reason: 'offline' };
    }

    if (
      await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.liveContent))
    ) {
      return { healthy: true, reason: 'live' };
    }

    return { healthy: false, reason: 'live_content_missing' };
  } catch (error: unknown) {
    return {
      healthy: false,
      reason: 'health_check_error',
      error: safeErrorMessage(error),
    };
  }
}

async function isVisible(locator: Locator): Promise<boolean> {
  return locator.first().isVisible();
}

async function hasUnsupportedPlayerError(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.locator('body').textContent();
    return (
      bodyText !== null &&
      (
        /This video is either unavailable or not supported in this browser/iu
          .test(bodyText) ||
        /Error\s*#4000/iu.test(bodyText)
      )
    );
  } catch {
    return false;
  }
}

export function isExpectedChannelUrl(
  currentUrl: string,
  targetUrl: string,
): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return (
      current.origin.toLocaleLowerCase('en-US') ===
        target.origin.toLocaleLowerCase('en-US') &&
      normalizePath(current.pathname) === normalizePath(target.pathname)
    );
  } catch {
    return false;
  }
}

function normalizePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/u, '') || '/';
  return normalized.toLocaleLowerCase('en-US');
}

function validateConfiguredChannel(
  channel: string,
  configuredChannels: readonly string[],
): void {
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error('Channel 必須是 1 到 25 字元的英數字或底線');
  }

  const normalizedChannel = channel.toLocaleLowerCase('en-US');
  const isConfigured = configuredChannels.some(
    (configuredChannel) =>
      configuredChannel.toLocaleLowerCase('en-US') === normalizedChannel,
  );
  if (!isConfigured) {
    throw new Error(`Channel "${channel}" 不在已驗證的設定清單中`);
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : fallback;
}

function safeErrorMessage(error: unknown): string {
  let message = 'Unknown channel session failure';
  try {
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error !== undefined && error !== null) {
      message = String(error);
    }
  } catch {
    message = 'Unserializable channel session failure';
  }
  return redactSensitiveString(message);
}

function safeLog(
  logger: ChannelSessionLogger,
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: LogFields,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Logging must not break session cleanup or timer callbacks.
  }
}
