import type { Locator, Page } from 'playwright';

import type { AppConfig } from '../config/AppConfig.js';
import {
  LOG_EVENTS,
  redactSensitiveString,
  type LogFields,
  type Logger,
} from '../logging/index.js';
import type { BrowserManager } from './BrowserManager.js';
import type {
  RewardClaimer,
  RewardClaimResult,
} from './RewardClaimer.js';
import {
  DefaultStreamPlaybackOptimizer,
  type StreamPlaybackOptimizer,
} from './StreamPlaybackOptimizer.js';

const CHANNEL_PATTERN = /^[A-Za-z0-9_]{1,25}$/u;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3;
const MAX_TIMER_JITTER_MS = 5_000;
const MAX_PAGE_REFRESH_JITTER_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CONTENT_WARNING_SETTLE_TIMEOUT_MS = 3_000;

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
  contentWarning: [
    '[data-a-target="content-classification-gate-overlay-start-watching-button"]',
    '[data-a-target="content-warning-start-watching-button"]',
    '[data-channel-health="content-warning"]',
    'button:has-text("Start Watching")',
    'button:has-text("開始觀看")',
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
  | 'content_warning'
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
  getRefreshStatus(): ChannelSessionRefreshStatus;
  refreshNow(): Promise<boolean>;
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

export interface ChannelSessionRefreshStatus {
  readonly channel: string;
  readonly enabled: boolean;
  readonly nextRefreshAt?: string;
  readonly secondsUntilRefresh?: number;
}

export interface ChannelSessionRefreshEvent {
  readonly channel: string;
  readonly reason: ChannelSessionRefreshReason;
  readonly startedAt: string;
}

export type ChannelSessionRefreshReason =
  | 'scheduled_refresh'
  | 'manual_refresh';

export type ChannelSessionRefreshObserver = (
  event: ChannelSessionRefreshEvent,
) => Promise<void> | void;

export interface DefaultChannelSessionOptions {
  readonly channel: string;
  readonly config: Pick<AppConfig, 'channels' | 'browser'>;
  readonly browserManager: BrowserManager;
  readonly rewardClaimer: RewardClaimer;
  readonly playbackOptimizer?: StreamPlaybackOptimizer;
  readonly logger?: ChannelSessionLogger;
  readonly healthFailureThreshold?: number;
  readonly healthEvaluator?: ChannelHealthEvaluator;
  readonly onInvalidated?: ChannelSessionInvalidationObserver;
  readonly onPageRefresh?: ChannelSessionRefreshObserver;
  readonly now?: () => Date;
}

export interface DefaultChannelSessionFactoryOptions {
  readonly config: Pick<AppConfig, 'channels' | 'browser'>;
  readonly browserManager: BrowserManager;
  readonly rewardClaimer: RewardClaimer;
  readonly playbackOptimizer?: StreamPlaybackOptimizer;
  readonly logger?: ChannelSessionLogger;
  readonly healthFailureThreshold?: number;
  readonly healthEvaluator?: ChannelHealthEvaluator;
  readonly onInvalidated?: ChannelSessionInvalidationObserver;
  readonly onPageRefresh?: ChannelSessionRefreshObserver;
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
  private readonly playbackOptimizer: StreamPlaybackOptimizer;
  private readonly logger: ChannelSessionLogger;
  private readonly healthFailureThreshold: number;
  private readonly healthEvaluator: ChannelHealthEvaluator;
  private readonly onInvalidated:
    | ChannelSessionInvalidationObserver
    | undefined;
  private readonly onPageRefresh:
    | ChannelSessionRefreshObserver
    | undefined;
  private readonly now: () => Date;

  private currentState: ChannelSessionState = 'stopped';
  private page: Page | undefined;
  private consecutiveHealthFailures = 0;
  private healthTimer: NodeJS.Timeout | undefined;
  private rewardTimer: NodeJS.Timeout | undefined;
  private playbackOptimizationTimer: NodeJS.Timeout | undefined;
  private pageRefreshTimer: NodeJS.Timeout | undefined;
  private healthFlight: Promise<ChannelHealthResult> | undefined;
  private rewardFlight: Promise<RewardClaimResult> | undefined;
  private reloadFlight: Promise<void> | undefined;
  private nextPageRefreshAtMs: number | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly options: DefaultChannelSessionOptions,
  ) {
    validateConfiguredChannel(options.channel, options.config.channels);
    this.channel = options.channel;
    this.targetUrl = createChannelUrl(options.channel);
    this.browserManager = options.browserManager;
    this.rewardClaimer = options.rewardClaimer;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.playbackOptimizer =
      options.playbackOptimizer ??
      new DefaultStreamPlaybackOptimizer(
        options.config.browser,
        this.logger,
      );
    this.healthFailureThreshold = positiveInteger(
      options.healthFailureThreshold,
      DEFAULT_HEALTH_FAILURE_THRESHOLD,
    );
    this.healthEvaluator =
      options.healthEvaluator ?? evaluateChannelHealth;
    this.onInvalidated = options.onInvalidated;
    this.onPageRefresh = options.onPageRefresh;
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
        await this.acceptContentWarningIfPresent(page, 'start');
        await this.optimizePlayback(page);

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

  public getRefreshStatus(): ChannelSessionRefreshStatus {
    const enabled =
      this.options.config.browser.pageRefreshIntervalSeconds > 0;
    const nextRefreshAtMs = this.nextPageRefreshAtMs;
    if (!enabled || nextRefreshAtMs === undefined) {
      return {
        channel: this.channel,
        enabled,
      };
    }

    return {
      channel: this.channel,
      enabled,
      nextRefreshAt: new Date(nextRefreshAtMs).toISOString(),
      secondsUntilRefresh: Math.max(
        0,
        Math.ceil((nextRefreshAtMs - this.now().getTime()) / 1_000),
      ),
    };
  }

  public async refreshNow(): Promise<boolean> {
    const page = this.page;
    if (
      page === undefined ||
      page.isClosed() ||
      !this.shouldScheduleWork()
    ) {
      return false;
    }

    this.notifyPageRefresh('manual_refresh');
    await this.reloadPage(page, 'manual_refresh');
    safeLog(this.logger, 'info', 'page_refreshed', {
      channel: this.channel,
      reason: 'manual_refresh',
    });
    return true;
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
      await this.reloadPage(page, 'health_failure');
    } catch (error: unknown) {
      safeLog(this.logger, 'warn', 'page_reload_failed', {
        channel: this.channel,
        reason: 'health_failure',
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
      return await this.rewardClaimer.claimIfAvailable(
        page,
        this.channel,
      );
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

  private startTimers(): void {
    if (
      this.healthTimer !== undefined ||
      this.rewardTimer !== undefined ||
      this.playbackOptimizationTimer !== undefined ||
      this.pageRefreshTimer !== undefined
    ) {
      return;
    }

    this.scheduleHealthCheck();
    this.scheduleRewardCheck();
    this.schedulePlaybackOptimization();
    this.schedulePageRefresh();
  }

  private clearTimers(): void {
    if (this.healthTimer !== undefined) {
      clearTimeout(this.healthTimer);
      this.healthTimer = undefined;
    }
    if (this.rewardTimer !== undefined) {
      clearTimeout(this.rewardTimer);
      this.rewardTimer = undefined;
    }
    if (this.playbackOptimizationTimer !== undefined) {
      clearTimeout(this.playbackOptimizationTimer);
      this.playbackOptimizationTimer = undefined;
    }
    if (this.pageRefreshTimer !== undefined) {
      clearTimeout(this.pageRefreshTimer);
      this.pageRefreshTimer = undefined;
    }
    this.nextPageRefreshAtMs = undefined;
  }

  private async optimizePlayback(page: Page): Promise<void> {
    try {
      await this.playbackOptimizer.optimize(page, this.channel);
    } catch (error: unknown) {
      safeLog(this.logger, 'debug', 'stream_playback_optimization_failed', {
        channel: this.channel,
        error: safeErrorMessage(error),
      });
    }
  }

  private async acceptContentWarningIfPresent(
    page: Page,
    reason: string,
  ): Promise<void> {
    const result = await acceptContentWarning(page);
    if (result === 'not_present') {
      return;
    }
    if (result === 'accepted') {
      safeLog(this.logger, 'info', 'content_warning_accepted', {
        channel: this.channel,
        reason,
      });
      return;
    }
    safeLog(this.logger, 'warn', 'content_warning_accept_failed', {
      channel: this.channel,
      reason,
    });
  }

  private scheduleHealthCheck(): void {
    if (!this.shouldScheduleWork()) {
      return;
    }
    this.healthTimer = setTimeout(() => {
      this.healthTimer = undefined;
      void this.checkHealth()
        .catch((error: unknown) => {
          safeLog(this.logger, 'error', 'page_health_timer_failed', {
            channel: this.channel,
            error: safeErrorMessage(error),
          });
        })
        .finally(() => {
          this.scheduleHealthCheck();
        });
    }, this.timerDelay(
      this.options.config.browser.pageHealthCheckIntervalSeconds,
      'health',
    ));
  }

  private scheduleRewardCheck(): void {
    if (!this.shouldScheduleWork()) {
      return;
    }
    this.rewardTimer = setTimeout(() => {
      this.rewardTimer = undefined;
      void this.tickRewardClaim()
        .catch((error: unknown) => {
          safeLog(this.logger, 'error', 'reward_timer_failed', {
            channel: this.channel,
            error: safeErrorMessage(error),
          });
        })
        .finally(() => {
          this.scheduleRewardCheck();
        });
    }, this.timerDelay(
      this.options.config.browser.rewardCheckIntervalSeconds,
      'reward',
    ));
  }

  private schedulePlaybackOptimization(): void {
    if (!this.shouldScheduleWork()) {
      return;
    }
    this.playbackOptimizationTimer = setTimeout(() => {
      this.playbackOptimizationTimer = undefined;
      const page = this.page;
      const work =
        page === undefined || page.isClosed()
          ? Promise.resolve()
          : this.optimizePlayback(page);
      void work.finally(() => {
        this.schedulePlaybackOptimization();
      });
    }, this.timerDelay(
      this.options.config.browser.enforceStreamQualitySeconds,
      'playback',
    ));
  }

  private schedulePageRefresh(): void {
    if (
      !this.shouldScheduleWork() ||
      this.options.config.browser.pageRefreshIntervalSeconds <= 0
    ) {
      return;
    }
    const delay = this.pageRefreshDelay();
    this.nextPageRefreshAtMs = this.now().getTime() + delay;
    this.pageRefreshTimer = setTimeout(() => {
      this.pageRefreshTimer = undefined;
      this.nextPageRefreshAtMs = undefined;
      void this.refreshPage()
        .catch((error: unknown) => {
          safeLog(this.logger, 'warn', 'page_refresh_failed', {
            channel: this.channel,
            error: safeErrorMessage(error),
          });
        })
        .finally(() => {
          this.schedulePageRefresh();
        });
    }, delay);
  }

  private async refreshPage(): Promise<void> {
    const page = this.page;
    if (
      page === undefined ||
      page.isClosed() ||
      !this.shouldScheduleWork()
    ) {
      return;
    }

    this.notifyPageRefresh('scheduled_refresh');
    await this.reloadPage(page, 'scheduled_refresh');
    safeLog(this.logger, 'info', 'page_refreshed', {
      channel: this.channel,
      reason: 'scheduled_refresh',
    });
  }

  private reloadPage(page: Page, reason: string): Promise<void> {
    const existingFlight = this.reloadFlight;
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const flight = this.runPageReload(page, reason);
    this.reloadFlight = flight;
    flight.then(
      () => {
        if (this.reloadFlight === flight) {
          this.reloadFlight = undefined;
        }
      },
      () => {
        if (this.reloadFlight === flight) {
          this.reloadFlight = undefined;
        }
      },
    );
    return flight;
  }

  private async runPageReload(page: Page, reason: string): Promise<void> {
    await page.reload();
    await this.acceptContentWarningIfPresent(page, reason);
    await this.optimizePlayback(page);
    safeLog(this.logger, 'debug', 'page_reloaded', {
      channel: this.channel,
      reason,
    });
  }

  private timerDelay(intervalSeconds: number, task: string): number {
    return Math.min(
      MAX_TIMER_DELAY_MS,
      intervalSeconds * 1_000 +
        stableJitter(`${this.channel}:${task}`, MAX_TIMER_JITTER_MS),
    );
  }

  private pageRefreshDelay(): number {
    const intervalMs =
      this.options.config.browser.pageRefreshIntervalSeconds * 1_000;
    const refreshJitterMs = Math.min(
      MAX_PAGE_REFRESH_JITTER_MS,
      Math.max(MAX_TIMER_JITTER_MS, Math.floor(intervalMs * 0.2)),
    );
    return Math.min(
      MAX_TIMER_DELAY_MS,
      intervalMs +
        stableJitter(`${this.channel}:page-refresh`, refreshJitterMs),
    );
  }

  private shouldScheduleWork(): boolean {
    return (
      this.currentState === 'watching' ||
      this.currentState === 'recovering'
    );
  }

  private async waitForCurrentWork(): Promise<void> {
    const currentWork: Promise<unknown>[] = [];
    if (this.healthFlight !== undefined) {
      currentWork.push(this.healthFlight);
    }
    if (this.rewardFlight !== undefined) {
      currentWork.push(this.rewardFlight);
    }
    if (this.reloadFlight !== undefined) {
      currentWork.push(this.reloadFlight);
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

  private notifyPageRefresh(reason: ChannelSessionRefreshReason): void {
    const observer = this.onPageRefresh;
    if (observer === undefined) {
      return;
    }

    const event: ChannelSessionRefreshEvent = {
      channel: this.channel,
      reason,
      startedAt: this.now().toISOString(),
    };
    void Promise.resolve()
      .then(() => observer(event))
      .catch((error: unknown) => {
        safeLog(this.logger, 'warn', 'page_refresh_notification_failed', {
          channel: this.channel,
          reason: event.reason,
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

    const contentWarningResult = await acceptContentWarning(page);
    if (
      contentWarningResult === 'accepted' &&
      await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.liveContent))
    ) {
      return { healthy: true, reason: 'live' };
    }
    if (contentWarningResult !== 'not_present') {
      return { healthy: false, reason: 'content_warning' };
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

type ContentWarningAcceptResult = 'not_present' | 'accepted' | 'blocked';

async function acceptContentWarning(
  page: Page,
): Promise<ContentWarningAcceptResult> {
  const button = page.locator(CHANNEL_HEALTH_SELECTORS.contentWarning).first();
  if (!(await isVisible(button))) {
    return 'not_present';
  }

  try {
    await button.click({ timeout: CONTENT_WARNING_SETTLE_TIMEOUT_MS });
    await page
      .locator(CHANNEL_HEALTH_SELECTORS.liveContent)
      .first()
      .waitFor({
        state: 'visible',
        timeout: CONTENT_WARNING_SETTLE_TIMEOUT_MS,
      })
      .catch(() => undefined);
    return 'accepted';
  } catch {
    return 'blocked';
  }
}

async function isVisible(locator: Locator): Promise<boolean> {
  return locator.first().isVisible();
}

async function hasUnsupportedPlayerError(page: Page): Promise<boolean> {
  try {
    const playerText = (
      await page
      .locator(
        [
          '[data-a-target="player-error-message"]',
          '[data-test-selector="video-player"]',
          '[data-a-target="video-player"]',
        ].join(', '),
      )
        .allTextContents()
    ).join(' ');
    return (
      /This video is either unavailable or not supported in this browser/iu
        .test(playerText) ||
      /Error\s*#4000/iu.test(playerText)
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

export function stableJitter(value: string, maximumMs: number): number {
  if (!Number.isSafeInteger(maximumMs) || maximumMs <= 0) {
    return 0;
  }
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % maximumMs;
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
