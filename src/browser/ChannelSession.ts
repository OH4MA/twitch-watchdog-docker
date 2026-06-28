import type { Page } from 'playwright';

import type { AppConfig } from '../config/AppConfig.js';
import {
  LOG_EVENTS,
  type Logger,
} from '../logging/index.js';
import type { BrowserManager } from './BrowserManager.js';
import {
  acceptContentWarning,
  evaluateChannelHealth,
  type ChannelHealthEvaluator,
  type ChannelHealthResult,
} from './ChannelHealthChecker.js';
import type {
  RewardClaimer,
  RewardClaimResult,
} from './RewardClaimer.js';
import {
  DefaultStreamPlaybackOptimizer,
  type StreamPlaybackOptimizer,
} from './StreamPlaybackOptimizer.js';
import {
  CHANNEL_PATTERN,
  createChannelUrl,
  isExpectedChannelUrl,
  stableJitter,
} from './channel-url.js';
import { safeErrorMessage, safeLog } from './safe-logging.js';

export {
  CHANNEL_HEALTH_SELECTORS,
  acceptContentWarning,
  evaluateChannelHealth,
  type ChannelHealthEvaluator,
  type ChannelHealthFailureReason,
  type ChannelHealthResult,
  type ContentWarningAcceptResult,
} from './ChannelHealthChecker.js';
export {
  createChannelUrl,
  isExpectedChannelUrl,
  stableJitter,
} from './channel-url.js';
export { safeErrorMessage, safeLog } from './safe-logging.js';

const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3;
const MAX_TIMER_JITTER_MS = 5_000;
const MAX_PAGE_REFRESH_JITTER_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const REWARD_FAILURE_RECOVERY_THRESHOLD = 10;

export type ChannelSessionState =
  | 'starting'
  | 'watching'
  | 'recovering'
  | 'stopping'
  | 'stopped'
  | 'failed';

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

export type ChannelSessionInvalidationObserver = (
  channel: string,
  reason: 'health_failure_threshold',
) => Promise<void> | void;

export interface ContainerRestartRequest {
  readonly channel: string;
  readonly reason: 'reward_claim_failure_after_refresh';
  readonly consecutiveFailures: number;
  readonly requestedAt: string;
}

export type ContainerRestartRequestObserver = (
  request: ContainerRestartRequest,
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
  | 'manual_refresh'
  | 'reward_claim_failure_threshold';

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
  readonly onContainerRestartRequested?: ContainerRestartRequestObserver;
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
  readonly onContainerRestartRequested?: ContainerRestartRequestObserver;
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
  private readonly onContainerRestartRequested:
    | ContainerRestartRequestObserver
    | undefined;
  private readonly now: () => Date;

  private currentState: ChannelSessionState = 'stopped';
  private page: Page | undefined;
  private consecutiveHealthFailures = 0;
  private consecutiveRewardFailures = 0;
  private rewardFailureRefreshAttempted = false;
  private containerRestartRequested = false;
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
    this.onContainerRestartRequested =
      options.onContainerRestartRequested;
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
      this.resetRewardFailureRecovery();

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
      this.resetRewardFailureRecovery();
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

    let result: RewardClaimResult;
    try {
      result = await this.rewardClaimer.claimIfAvailable(
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
      result = {
        status: 'click_failed',
        channel: this.channel,
        checkedAt,
        error: safeError,
      };
    }

    await this.handleRewardClaimResult(page, result);
    return result;
  }

  private async handleRewardClaimResult(
    page: Page,
    result: RewardClaimResult,
  ): Promise<void> {
    if (result.status !== 'click_failed') {
      this.resetRewardFailureRecovery();
      return;
    }

    this.consecutiveRewardFailures += 1;

    if (
      this.consecutiveRewardFailures <
      REWARD_FAILURE_RECOVERY_THRESHOLD
    ) {
      return;
    }

    safeLog(
      this.logger,
      'warn',
      LOG_EVENTS.REWARD_CLAIM_FAILURE_THRESHOLD,
      {
        channel: this.channel,
        consecutiveFailures: this.consecutiveRewardFailures,
        threshold: REWARD_FAILURE_RECOVERY_THRESHOLD,
        recoveryRefreshAttempted: this.rewardFailureRefreshAttempted,
        error: result.error,
      },
    );

    if (!this.rewardFailureRefreshAttempted) {
      await this.refreshAfterRewardFailures(page);
      return;
    }

    this.requestContainerRestartAfterRewardFailures();
  }

  private async refreshAfterRewardFailures(page: Page): Promise<void> {
    this.rewardFailureRefreshAttempted = true;
    safeLog(
      this.logger,
      'warn',
      LOG_EVENTS.REWARD_CLAIM_FAILURE_RECOVERY_REFRESH,
      {
        channel: this.channel,
        threshold: REWARD_FAILURE_RECOVERY_THRESHOLD,
        reason: 'reward_claim_failure_threshold',
      },
    );

    if (page.isClosed()) {
      this.requestContainerRestartAfterRewardFailures();
      return;
    }

    try {
      this.notifyPageRefresh('reward_claim_failure_threshold');
      await this.reloadPage(page, 'reward_claim_failure_threshold');
      this.consecutiveRewardFailures = 0;
      safeLog(this.logger, 'info', 'page_refreshed', {
        channel: this.channel,
        reason: 'reward_claim_failure_threshold',
      });
    } catch (error: unknown) {
      safeLog(this.logger, 'warn', 'page_reload_failed', {
        channel: this.channel,
        reason: 'reward_claim_failure_threshold',
        error: safeErrorMessage(error),
      });
      this.requestContainerRestartAfterRewardFailures();
    }
  }

  private requestContainerRestartAfterRewardFailures(): void {
    if (this.containerRestartRequested) {
      return;
    }

    this.containerRestartRequested = true;
    const request: ContainerRestartRequest = {
      channel: this.channel,
      reason: 'reward_claim_failure_after_refresh',
      consecutiveFailures: this.consecutiveRewardFailures,
      requestedAt: this.now().toISOString(),
    };
    safeLog(
      this.logger,
      'error',
      LOG_EVENTS.CONTAINER_RESTART_REQUESTED,
      {
        channel: request.channel,
        reason: request.reason,
        consecutiveFailures: request.consecutiveFailures,
        requestedAt: request.requestedAt,
      },
    );

    const observer = this.onContainerRestartRequested;
    if (observer === undefined) {
      return;
    }

    void Promise.resolve()
      .then(() => observer(request))
      .catch((error: unknown) => {
        safeLog(this.logger, 'error', 'container_restart_request_failed', {
          channel: this.channel,
          reason: request.reason,
          error: safeErrorMessage(error),
        });
      });
  }

  private resetRewardFailureRecovery(): void {
    this.consecutiveRewardFailures = 0;
    this.rewardFailureRefreshAttempted = false;
    this.containerRestartRequested = false;
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
