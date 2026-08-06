import type { Page } from 'playwright';

import {
  LOG_EVENTS,
  redactSensitiveString,
} from '../logging/Logger.js';
import { PlaywrightBrowserLauncher } from './adapters/PlaywrightBrowserLauncher.js';
import type {
  BrowserAdapter,
  BrowserContextAdapter,
  BrowserFatalRecoveryObserver,
  BrowserInvalidation,
  BrowserInvalidationObserver,
  BrowserInvalidationReason,
  BrowserLauncher,
  BrowserManager,
  BrowserManagerConfig,
  BrowserManagerDependencies,
  BrowserManagerLogger,
  BrowserNavigationOutcome,
  BrowserPageAdapter,
  BrowserRestartedEvent,
  BrowserRestartedObserver,
  BrowserTeardownResult,
  CloseOutcome,
  DetachedResources,
  PageEntry,
  RestartSchedule,
} from './types.js';

export { PlaywrightBrowserLauncher } from './adapters/PlaywrightBrowserLauncher.js';
export type {
  BrowserAdapter,
  BrowserContextAdapter,
  BrowserContextOptions,
  BrowserFatalRecoveryObserver,
  BrowserInvalidation,
  BrowserInvalidationObserver,
  BrowserInvalidationReason,
  BrowserLauncher,
  BrowserLaunchOptions,
  BrowserManager,
  BrowserManagerConfig,
  BrowserManagerDependencies,
  BrowserManagerLogger,
  BrowserNavigationOutcome,
  BrowserPageAdapter,
  BrowserRestartedEvent,
  BrowserRestartedObserver,
  BrowserTeardownResult,
  CloseOutcome,
  ResourceBlockingOptions,
} from './types.js';

const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const DEFAULT_RESTART_BACKOFF_MAX_MS = 30_000;
const DEFAULT_MAX_AUTOMATIC_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_ATTEMPT_RESET_MS = 60_000;
const DEFAULT_RESOURCE_CLOSE_TIMEOUT_MS = 10_000;
const DEFAULT_CHANNEL_CRASH_RECYCLE_THRESHOLD = 2;
const DEFAULT_CHANNEL_CRASH_WINDOW_MS = 5 * 60_000;
const DEFAULT_GLOBAL_PAGE_CRASH_RECYCLE_THRESHOLD = 3;
const DEFAULT_GLOBAL_PAGE_CRASH_WINDOW_MS = 10 * 60_000;
const DEFAULT_CHANNEL_NAVIGATION_TIMEOUT_RECYCLE_THRESHOLD = 2;
const DEFAULT_CHANNEL_NAVIGATION_TIMEOUT_WINDOW_MS = 5 * 60_000;
const DEFAULT_GLOBAL_NAVIGATION_TIMEOUT_RECYCLE_THRESHOLD = 3;
const DEFAULT_GLOBAL_NAVIGATION_TIMEOUT_WINDOW_MS = 5 * 60_000;
const DEFAULT_BROWSER_FAILURE_CONTAINER_THRESHOLD = 3;
const DEFAULT_BROWSER_FAILURE_WINDOW_MS = 10 * 60_000;

interface NavigationTimeoutEntry {
  readonly channel: string;
  readonly timestampMs: number;
}

interface NavigationTimeoutRecoveryDecision {
  readonly reason:
    | 'channel_navigation_timeout_loop'
    | 'global_navigation_timeout_loop';
  readonly channel: string;
  readonly channelTimeoutCount: number;
  readonly globalTimeoutCount: number;
}

export class BrowserTerminationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BrowserTerminationError';
  }
}

const NOOP_LOGGER: BrowserManagerLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

export class DefaultBrowserManager implements BrowserManager {
  private readonly launcher: BrowserLauncher;
  private readonly logger: BrowserManagerLogger;
  private readonly onInvalidated: BrowserInvalidationObserver | undefined;
  private readonly onFatalRecovery: BrowserFatalRecoveryObserver | undefined;
  private readonly onBrowserRestarted: BrowserRestartedObserver | undefined;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly restartBackoffMs: number;
  private readonly restartBackoffMaxMs: number;
  private readonly maxAutomaticRestartAttempts: number;
  private readonly restartAttemptResetMs: number;
  private readonly resourceCloseTimeoutMs: number;
  private readonly channelCrashRecycleThreshold: number;
  private readonly channelCrashWindowMs: number;
  private readonly globalPageCrashRecycleThreshold: number;
  private readonly globalPageCrashWindowMs: number;
  private readonly browserFailureContainerThreshold: number;
  private readonly browserFailureWindowMs: number;

  private browser: BrowserAdapter | undefined;
  private context: BrowserContextAdapter | undefined;
  private unsubscribeBrowser: (() => void) | undefined;
  private readonly pages = new Map<string, PageEntry>();
  private operationTail: Promise<void> = Promise.resolve();
  private navigationOutcomeTail: Promise<void> = Promise.resolve();
  private restartFlight: Promise<void> | undefined;
  private automaticRestartFlight: Promise<void> | undefined;
  private automaticRestartToken: symbol | undefined;
  private automaticRestartRecoveryEpoch: number | undefined;
  private desiredRunning = false;
  private recoveryEpoch = 0;
  private automaticRestartAttempts = 0;
  private lastBrowserCrashAt: number | undefined;
  private pendingForcedRecycleReason: string | undefined;
  private readonly channelCrashTimestamps = new Map<string, number[]>();
  private globalPageCrashTimestamps: number[] = [];
  private readonly channelNavigationTimeoutTimestamps =
    new Map<string, number[]>();
  private globalNavigationTimeouts: NavigationTimeoutEntry[] = [];
  private browserFailureTimestamps: number[] = [];

  public constructor(
    private readonly config: BrowserManagerConfig,
    dependencies: BrowserManagerDependencies = {},
  ) {
    this.launcher = dependencies.launcher ?? new PlaywrightBrowserLauncher();
    this.logger = dependencies.logger ?? NOOP_LOGGER;
    this.onInvalidated = dependencies.onInvalidated;
    this.onFatalRecovery = dependencies.onFatalRecovery;
    this.onBrowserRestarted = dependencies.onBrowserRestarted;
    this.sleep =
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    this.now = dependencies.now ?? Date.now;
    this.restartBackoffMs = positiveInteger(
      dependencies.restartBackoffMs,
      DEFAULT_RESTART_BACKOFF_MS,
    );
    this.restartBackoffMaxMs = positiveInteger(
      dependencies.restartBackoffMaxMs,
      DEFAULT_RESTART_BACKOFF_MAX_MS,
    );
    this.maxAutomaticRestartAttempts = positiveInteger(
      dependencies.maxAutomaticRestartAttempts,
      DEFAULT_MAX_AUTOMATIC_RESTART_ATTEMPTS,
    );
    this.restartAttemptResetMs = positiveInteger(
      dependencies.restartAttemptResetMs,
      DEFAULT_RESTART_ATTEMPT_RESET_MS,
    );
    this.resourceCloseTimeoutMs = positiveInteger(
      dependencies.resourceCloseTimeoutMs,
      DEFAULT_RESOURCE_CLOSE_TIMEOUT_MS,
    );
    this.channelCrashRecycleThreshold = positiveInteger(
      dependencies.channelCrashRecycleThreshold,
      DEFAULT_CHANNEL_CRASH_RECYCLE_THRESHOLD,
    );
    this.channelCrashWindowMs = positiveInteger(
      dependencies.channelCrashWindowMs,
      DEFAULT_CHANNEL_CRASH_WINDOW_MS,
    );
    this.globalPageCrashRecycleThreshold = positiveInteger(
      dependencies.globalPageCrashRecycleThreshold,
      DEFAULT_GLOBAL_PAGE_CRASH_RECYCLE_THRESHOLD,
    );
    this.globalPageCrashWindowMs = positiveInteger(
      dependencies.globalPageCrashWindowMs,
      DEFAULT_GLOBAL_PAGE_CRASH_WINDOW_MS,
    );
    this.browserFailureContainerThreshold = positiveInteger(
      dependencies.browserFailureContainerThreshold,
      DEFAULT_BROWSER_FAILURE_CONTAINER_THRESHOLD,
    );
    this.browserFailureWindowMs = positiveInteger(
      dependencies.browserFailureWindowMs,
      DEFAULT_BROWSER_FAILURE_WINDOW_MS,
    );
  }

  public async start(): Promise<void> {
    await this.runExclusive(async () => {
      if (this.browser !== undefined && this.context !== undefined) {
        this.desiredRunning = true;
        return;
      }

      this.desiredRunning = true;
      this.recoveryEpoch += 1;
      this.automaticRestartAttempts = 0;
      this.lastBrowserCrashAt = undefined;

      try {
        await this.startUnlocked();
      } catch (error: unknown) {
        this.desiredRunning = false;
        this.logger.error('browser_start_failed', {
          error: this.safeError(error),
        });
        throw error;
      }
    });
  }

  public async stop(): Promise<void> {
    await this.runExclusive(async () => {
      this.desiredRunning = false;
      this.recoveryEpoch += 1;
      this.automaticRestartAttempts = 0;
      this.lastBrowserCrashAt = undefined;

      const resources = this.detachResourcesUnlocked();
      await this.closeResourcesUnlocked(resources, 'stop');
    });
  }

  public async createPage(channel: string): Promise<Page> {
    // Wait for any in-flight full recycle scheduled after a failed page close.
    const pendingRestart = this.restartFlight;
    if (pendingRestart !== undefined) {
      await pendingRestart;
    }

    return this.runExclusive(async () => {
      if (this.pendingForcedRecycleReason !== undefined) {
        throw new Error(
          `Browser recycle required (${this.pendingForcedRecycleReason}); cannot create page`,
        );
      }

      const existing = this.pages.get(channel);
      if (existing !== undefined) {
        return existing.adapter.page;
      }

      const context = this.context;
      if (context === undefined || this.browser === undefined) {
        throw new Error('Browser Manager 尚未啟動');
      }

      let adapter: BrowserPageAdapter | undefined;

      try {
        adapter = await context.newPage();
        const entry = this.attachPageUnlocked(channel, adapter);
        this.pages.set(channel, entry);
        return adapter.page;
      } catch (error: unknown) {
        if (adapter !== undefined) {
          await this.closePageAdapterForCleanup(adapter, channel, 'create');
        }
        this.logger.error('browser_page_create_failed', {
          channel,
          error: this.safeError(error),
        });
        throw error;
      }
    });
  }

  public async closePage(channel: string): Promise<void> {
    let scheduleRecycleReason: string | undefined;

    await this.runExclusive(async () => {
      const entry = this.pages.get(channel);
      if (entry === undefined) {
        return;
      }

      this.detachPageListeners(entry);
      const outcome = await this.closePageAdapterWithTimeout(
        entry.adapter,
        channel,
        'close',
      );

      if (
        outcome.status === 'closed' ||
        outcome.status === 'already_closed' ||
        entry.adapter.isClosed()
      ) {
        if (this.pages.get(channel) === entry) {
          this.pages.delete(channel);
        }
        return;
      }

      // Timeout or failed close while page may still be alive: do not allow
      // another page in the same shared context. Schedule a full browser recycle
      // asynchronously after releasing the exclusive lock (avoids SessionManager
      // / BrowserManager lock cycles).
      if (this.pages.get(channel) === entry) {
        this.pages.delete(channel);
      }
      scheduleRecycleReason =
        outcome.status === 'timed_out'
          ? 'page_close_timeout'
          : 'page_close_failed';
      this.pendingForcedRecycleReason = scheduleRecycleReason;
      this.logger.warn('browser_page_close_requires_recycle', {
        channel,
        reason: scheduleRecycleReason,
        phase: 'close',
      });
    });

    if (scheduleRecycleReason !== undefined) {
      void this.restart().catch((error: unknown) => {
        this.logger.error('browser_page_close_recycle_failed', {
          reason: scheduleRecycleReason,
          error: this.safeError(error),
        });
        this.requestFatalRecovery('browser_page_close_recycle_failed', {
          reason: scheduleRecycleReason,
        });
      });
    }
  }

  public restart(): Promise<void> {
    const existingFlight = this.restartFlight;
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const flight = this.restartManually();
    this.restartFlight = flight;
    flight.then(
      () => {
        if (this.restartFlight === flight) {
          this.restartFlight = undefined;
        }
      },
      () => {
        if (this.restartFlight === flight) {
          this.restartFlight = undefined;
        }
      },
    );
    return flight;
  }

  public getPageCount(): number {
    return this.pages.size;
  }

  public reportNavigationOutcomes(
    outcomes: readonly BrowserNavigationOutcome[],
  ): Promise<void> {
    if (outcomes.length === 0) {
      return Promise.resolve();
    }

    const reportedRecoveryEpoch = this.recoveryEpoch;
    const outcomeSnapshot = [...outcomes];
    const result = this.navigationOutcomeTail.then(
      () =>
        this.processNavigationOutcomes(
          outcomeSnapshot,
          reportedRecoveryEpoch,
        ),
      () =>
        this.processNavigationOutcomes(
          outcomeSnapshot,
          reportedRecoveryEpoch,
        ),
    );
    this.navigationOutcomeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async restartManually(): Promise<void> {
    const invalidatedChannels: string[] = [];
    let terminationConfirmed = false;
    let relaunchError: unknown;

    try {
      await this.runExclusive(async () => {
        this.desiredRunning = true;
        this.recoveryEpoch += 1;
        this.automaticRestartAttempts = 0;
        this.lastBrowserCrashAt = undefined;
        this.pendingForcedRecycleReason = undefined;
        invalidatedChannels.push(...this.pages.keys());

        const resources = this.detachResourcesUnlocked();
        const teardown = await this.closeResourcesUnlocked(
          resources,
          'restart',
        );
        terminationConfirmed = teardown.browserTerminated;

        if (!terminationConfirmed) {
          this.logger.error('browser_termination_unconfirmed', {
            mode: 'manual',
            pageCloseTimedOut: teardown.pageCloseTimedOut,
            browserCloseTimedOut: teardown.browserCloseTimedOut,
            browserCloseFailed: teardown.browserCloseFailed,
          });
          return;
        }

        try {
          await this.startUnlocked();
          this.logger.warn(LOG_EVENTS.BROWSER_RESTARTED, {
            mode: 'manual',
            affectedChannelCount: invalidatedChannels.length,
          });
          this.emitBrowserRestarted({ mode: 'manual' });
        } catch (error: unknown) {
          relaunchError = error;
          this.logger.error('browser_restart_failed', {
            mode: 'manual',
            error: this.safeError(error),
          });
        }
      });
    } finally {
      await this.notifyInvalidations(
        invalidatedChannels,
        'browser_restarted',
      );
    }

    if (!terminationConfirmed) {
      this.requestFatalRecovery('browser_termination_unconfirmed', {
        mode: 'manual',
      });
      throw new BrowserTerminationError(
        'Old browser termination was not confirmed; replacement launch skipped',
      );
    }

    if (relaunchError !== undefined) {
      throw relaunchError instanceof Error
        ? relaunchError
        : new Error('Browser relaunch failed');
    }
  }

  private async startUnlocked(): Promise<void> {
    if (this.browser !== undefined && this.context !== undefined) {
      return;
    }

    let browser: BrowserAdapter | undefined;
    let context: BrowserContextAdapter | undefined;
    let unsubscribeBrowser: (() => void) | undefined;

    try {
      browser = await this.launcher.launch({
        headless: this.config.headless,
      });
      const launchedBrowser = browser;
      unsubscribeBrowser = browser.onDisconnected(() => {
        void this.handleBrowserDisconnected(launchedBrowser);
      });
      context = await browser.newContext({
        storageState: this.config.storageStatePath,
        viewport: {
          width: this.config.browser.viewportWidth,
          height: this.config.browser.viewportHeight,
        },
      });
      await context.configureResourceBlocking({
        blockImages: this.config.browser.blockImages,
        blockFonts: this.config.browser.blockFonts,
        blockKnownTracking: this.config.browser.blockKnownTracking,
      });
      await context.configureChatBlocking(this.config.browser.disableChat);

      this.browser = browser;
      this.context = context;
      this.unsubscribeBrowser = unsubscribeBrowser;
      this.clearNavigationTimeouts();
    } catch (error: unknown) {
      unsubscribeBrowser?.();
      await this.closeResourcesUnlocked(
        {
          browser,
          context,
          pages: [],
          unsubscribeBrowser: undefined,
        },
        'start_failure',
      );
      throw error;
    }
  }

  private attachPageUnlocked(
    channel: string,
    adapter: BrowserPageAdapter,
  ): PageEntry {
    const entry: PageEntry = {
      adapter,
      unsubscribeCrash: () => undefined,
      unsubscribeClose: () => undefined,
      unsubscribePopup: () => undefined,
    };

    try {
      entry.unsubscribeCrash = adapter.onCrash(() => {
        void this.handlePageInvalidation(channel, adapter, 'page_crashed');
      });
      entry.unsubscribeClose = adapter.onClose(() => {
        void this.handlePageInvalidation(channel, adapter, 'page_closed');
      });
      entry.unsubscribePopup = adapter.onPopup((popup) => {
        void this.closeUnexpectedPopup(channel, popup);
      });
    } catch (error: unknown) {
      this.detachPageListeners(entry);
      throw error;
    }
    return entry;
  }

  private reattachPageListeners(channel: string, entry: PageEntry): void {
    entry.unsubscribeCrash = entry.adapter.onCrash(() => {
      void this.handlePageInvalidation(
        channel,
        entry.adapter,
        'page_crashed',
      );
    });
    entry.unsubscribeClose = entry.adapter.onClose(() => {
      void this.handlePageInvalidation(channel, entry.adapter, 'page_closed');
    });
    entry.unsubscribePopup = entry.adapter.onPopup((popup) => {
      void this.closeUnexpectedPopup(channel, popup);
    });
  }

  private async closeUnexpectedPopup(
    channel: string,
    popup: Page,
  ): Promise<void> {
    try {
      if (!popup.isClosed()) {
        await popup.close();
      }
      this.logger.warn('browser_popup_blocked', { channel });
    } catch (error: unknown) {
      this.logger.warn('browser_popup_close_failed', {
        channel,
        error: this.safeError(error),
      });
    }
  }

  private async handlePageInvalidation(
    channel: string,
    adapter: BrowserPageAdapter,
    reason: Extract<
      BrowserInvalidationReason,
      'page_crashed' | 'page_closed'
    >,
  ): Promise<void> {
    const startedAtMs = Date.now();
    this.logger.debug('browser_page_invalidation_started', {
      channel,
      reason,
      pageCountBefore: this.pages.size,
    });
    let shouldNotify: boolean;

    try {
      shouldNotify = await this.runExclusive(async () => {
        const entry = this.pages.get(channel);
        if (entry === undefined || entry.adapter !== adapter) {
          this.logger.debug('browser_page_invalidation_completed', {
            channel,
            reason,
            pageKnown: false,
            notified: false,
            pageCountAfter: this.pages.size,
            durationMs: Date.now() - startedAtMs,
          });
          return false;
        }

        this.pages.delete(channel);
        this.detachPageListeners(entry);

        if (reason === 'page_crashed') {
          await this.closePageAdapterForCleanup(adapter, channel, 'crash');
        }

        this.logger.warn(reason, { channel });
        this.logger.debug('browser_page_invalidation_completed', {
          channel,
          reason,
          pageKnown: true,
          notified: true,
          pageCountAfter: this.pages.size,
          durationMs: Date.now() - startedAtMs,
        });
        return true;
      });
    } catch (error: unknown) {
      this.logger.error('browser_page_invalidation_failed', {
        channel,
        reason,
        error: this.safeError(error),
      });
      return;
    }

    if (shouldNotify) {
      await this.notifyInvalidation({ channel, reason });
      this.logger.debug('browser_page_invalidation_notified', {
        channel,
        reason,
        durationMs: Date.now() - startedAtMs,
      });
      if (reason === 'page_crashed') {
        this.recordPageCrash(channel);
      }
    }
  }

  private async handleBrowserDisconnected(
    disconnectedBrowser: BrowserAdapter,
  ): Promise<void> {
    let invalidatedChannels: string[] = [];
    let restartSchedule: RestartSchedule | undefined;
    let escalateToContainer = false;

    try {
      await this.runExclusive(async () => {
        if (this.browser !== disconnectedBrowser) {
          return;
        }

        invalidatedChannels = [...this.pages.keys()];
        this.recoveryEpoch += 1;
        const recoveryEpoch = this.recoveryEpoch;
        const resources = this.detachResourcesUnlocked();

        this.logger.warn('browser_disconnected', {
          affectedChannelCount: invalidatedChannels.length,
        });
        await this.closeResourcesUnlocked(resources, 'disconnect');

        if (this.desiredRunning && this.config.browser.restartOnCrash) {
          escalateToContainer = this.recordBrowserFailure();
          if (!escalateToContainer) {
            restartSchedule = this.nextRestartSchedule(recoveryEpoch, true);
          }
        }
      });
    } catch (error: unknown) {
      this.logger.error('browser_disconnect_cleanup_failed', {
        error: this.safeError(error),
      });
    }

    await this.notifyInvalidations(
      invalidatedChannels,
      'browser_disconnected',
    );

    if (escalateToContainer) {
      this.requestFatalRecovery('browser_crash_loop', {
        browserFailureWindowMs: this.browserFailureWindowMs,
        browserFailureContainerThreshold:
          this.browserFailureContainerThreshold,
      });
      return;
    }

    if (restartSchedule !== undefined) {
      this.scheduleAutomaticRestart(restartSchedule);
    }
  }

  private nextRestartSchedule(
    recoveryEpoch: number,
    resetAttemptsAfterStablePeriod: boolean,
  ): RestartSchedule | undefined {
    if (resetAttemptsAfterStablePeriod) {
      const crashAt = this.now();
      if (
        this.lastBrowserCrashAt === undefined ||
        crashAt - this.lastBrowserCrashAt >= this.restartAttemptResetMs
      ) {
        this.automaticRestartAttempts = 0;
      }
      this.lastBrowserCrashAt = crashAt;
    }

    if (
      this.automaticRestartAttempts >=
      this.maxAutomaticRestartAttempts
    ) {
      this.logger.error('browser_restart_limit_reached', {
        maxAttempts: this.maxAutomaticRestartAttempts,
      });
      this.requestFatalRecovery('automatic_restart_limit_reached', {
        maxAttempts: this.maxAutomaticRestartAttempts,
      });
      return undefined;
    }

    this.automaticRestartAttempts += 1;
    const attempt = this.automaticRestartAttempts;
    const delayMs = Math.min(
      this.restartBackoffMs * 2 ** (attempt - 1),
      this.restartBackoffMaxMs,
    );

    this.logger.warn('browser_restart_scheduled', { attempt, delayMs });
    return { attempt, delayMs, recoveryEpoch };
  }

  private scheduleAutomaticRestart(schedule: RestartSchedule): void {
    if (
      this.automaticRestartFlight !== undefined &&
      this.automaticRestartRecoveryEpoch === schedule.recoveryEpoch
    ) {
      return;
    }

    const token = Symbol('automatic-browser-restart');
    this.automaticRestartToken = token;
    this.automaticRestartRecoveryEpoch = schedule.recoveryEpoch;
    const flight = Promise.resolve().then(async () => {
      try {
        await this.sleep(schedule.delayMs);
      } catch (error: unknown) {
        this.logger.error('browser_restart_backoff_failed', {
          attempt: schedule.attempt,
          error: this.safeError(error),
        });
        return;
      } finally {
        if (this.automaticRestartToken === token) {
          this.automaticRestartToken = undefined;
          this.automaticRestartRecoveryEpoch = undefined;
          this.automaticRestartFlight = undefined;
        }
      }

      await this.recoverAutomatically(schedule);
    });

    this.automaticRestartFlight = flight;
    flight.catch((error: unknown) => {
      this.logger.error('browser_restart_task_failed', {
        attempt: schedule.attempt,
        error: this.safeError(error),
      });
    });
  }

  private async recoverAutomatically(schedule: RestartSchedule): Promise<void> {
    await this.runExclusive(async () => {
      if (
        !this.desiredRunning ||
        schedule.recoveryEpoch !== this.recoveryEpoch ||
        (this.browser !== undefined && this.context !== undefined)
      ) {
        return;
      }

      try {
        await this.startUnlocked();
      } catch (error: unknown) {
        this.logger.error('browser_restart_failed', {
          mode: 'automatic',
          attempt: schedule.attempt,
          error: this.safeError(error),
        });
        const retrySchedule = this.nextRestartSchedule(
          schedule.recoveryEpoch,
          false,
        );
        if (retrySchedule !== undefined) {
          this.scheduleAutomaticRestart(retrySchedule);
        }
        // When retrySchedule is undefined, nextRestartSchedule already
        // requested a container restart for attempt exhaustion.
        return;
      }

      this.logger.warn(LOG_EVENTS.BROWSER_RESTARTED, {
        mode: 'automatic',
        attempt: schedule.attempt,
      });
      this.emitBrowserRestarted({ mode: 'automatic' });
    });
  }

  private emitBrowserRestarted(event: BrowserRestartedEvent): void {
    try {
      this.onBrowserRestarted?.(event);
    } catch (error: unknown) {
      this.logger.debug('browser_restarted_observer_failed', {
        error: this.safeError(error),
      });
    }
  }

  private detachResourcesUnlocked(): DetachedResources {
    const resources: DetachedResources = {
      browser: this.browser,
      context: this.context,
      pages: [...this.pages.values()],
      unsubscribeBrowser: this.unsubscribeBrowser,
    };

    this.browser = undefined;
    this.context = undefined;
    this.unsubscribeBrowser = undefined;
    this.pages.clear();
    resources.unsubscribeBrowser?.();
    for (const entry of resources.pages) {
      this.detachPageListeners(entry);
    }

    return resources;
  }

  private async closeResourcesUnlocked(
    resources: DetachedResources,
    phase: string,
  ): Promise<BrowserTeardownResult> {
    let pageCloseTimedOut = false;

    for (const entry of resources.pages) {
      const pageOutcome = await this.closePageAdapterForCleanup(
        entry.adapter,
        undefined,
        phase,
      );
      if (pageOutcome.status === 'timed_out') {
        pageCloseTimedOut = true;
      }
    }

    await this.closeResourceForCleanup(
      resources.context,
      'browser_context_close_failed',
      phase,
    );

    let browserCloseTimedOut = false;
    let browserCloseFailed = false;
    const browser = resources.browser;
    if (browser !== undefined) {
      // Already disconnected: cleanup errors on wrappers are non-fatal.
      if (!browser.isConnected()) {
        await this.closeResourceForCleanup(
          browser,
          'browser_close_failed',
          phase,
        );
        return {
          browserTerminated: true,
          pageCloseTimedOut,
          browserCloseTimedOut: false,
          browserCloseFailed: false,
        };
      }

      const browserOutcome = await this.closeResourceForCleanup(
        browser,
        'browser_close_failed',
        phase,
      );
      browserCloseTimedOut = browserOutcome.status === 'timed_out';
      browserCloseFailed = browserOutcome.status === 'failed';
    }

    const browserTerminated =
      browser === undefined || !browser.isConnected();

    return {
      browserTerminated,
      pageCloseTimedOut,
      browserCloseTimedOut,
      browserCloseFailed,
    };
  }

  private async closePageAdapterForCleanup(
    adapter: BrowserPageAdapter,
    channel: string | undefined,
    phase: string,
  ): Promise<CloseOutcome> {
    if (adapter.isClosed()) {
      return { status: 'already_closed' };
    }

    const outcome = await this.closePageAdapterWithTimeout(
      adapter,
      channel,
      phase,
    );
    if (outcome.status === 'failed') {
      this.logger.warn('browser_page_cleanup_failed', {
        ...(channel === undefined ? {} : { channel }),
        phase,
        error: this.safeError(outcome.error),
      });
    }
    return outcome;
  }

  private async closeResourceForCleanup(
    resource: { close(): Promise<void> } | undefined,
    event: string,
    phase: string,
  ): Promise<CloseOutcome> {
    if (resource === undefined) {
      return { status: 'already_closed' };
    }

    const outcome = await this.closeWithTimeout(
      resource.close(),
      event.replace('_failed', '_timeout'),
      { phase },
    );
    if (outcome.status === 'failed') {
      this.logger.warn(event, {
        phase,
        error: this.safeError(outcome.error),
      });
    }
    return outcome;
  }

  private async closePageAdapterWithTimeout(
    adapter: BrowserPageAdapter,
    channel: string | undefined,
    phase: string,
  ): Promise<CloseOutcome> {
    if (adapter.isClosed()) {
      return { status: 'already_closed' };
    }
    return this.closeWithTimeout(
      adapter.close(),
      'browser_page_close_timeout',
      {
        ...(channel === undefined ? {} : { channel }),
        phase,
      },
    );
  }

  private async closeWithTimeout(
    closePromise: Promise<void>,
    timeoutEvent: string,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<CloseOutcome> {
    const startedAtMs = Date.now();
    this.logger.debug('browser_resource_close_started', {
      ...fields,
      timeoutEvent,
      timeoutMs: this.resourceCloseTimeoutMs,
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    // Attach rejection handler so a late rejection after timeout is not unhandled.
    closePromise.catch(() => undefined);

    try {
      const raceResult = await Promise.race([
        closePromise.then(
          () => ({ kind: 'closed' as const }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        ),
        new Promise<{ kind: 'timed_out' }>((resolve) => {
          timeoutHandle = setTimeout(() => {
            resolve({ kind: 'timed_out' });
          }, this.resourceCloseTimeoutMs);
        }),
      ]);

      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }

      if (raceResult.kind === 'timed_out') {
        this.logger.warn(timeoutEvent, {
          ...fields,
          timeoutMs: this.resourceCloseTimeoutMs,
        });
        this.logger.debug('browser_resource_close_completed', {
          ...fields,
          timeoutEvent,
          timedOut: true,
          status: 'timed_out',
          durationMs: Date.now() - startedAtMs,
        });
        return { status: 'timed_out' };
      }

      if (raceResult.kind === 'failed') {
        this.logger.debug('browser_resource_close_completed', {
          ...fields,
          timeoutEvent,
          timedOut: false,
          status: 'failed',
          durationMs: Date.now() - startedAtMs,
        });
        return { status: 'failed', error: raceResult.error };
      }

      this.logger.debug('browser_resource_close_completed', {
        ...fields,
        timeoutEvent,
        timedOut: false,
        status: 'closed',
        durationMs: Date.now() - startedAtMs,
      });
      return { status: 'closed' };
    } catch (error: unknown) {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      return { status: 'failed', error };
    }
  }

  private recordPageCrash(channel: string): void {
    const nowMs = this.now();
    const channelTimes = evictOldTimestamps(
      this.channelCrashTimestamps.get(channel) ?? [],
      nowMs,
      this.channelCrashWindowMs,
    );
    channelTimes.push(nowMs);
    this.channelCrashTimestamps.set(channel, channelTimes);

    this.globalPageCrashTimestamps = evictOldTimestamps(
      this.globalPageCrashTimestamps,
      nowMs,
      this.globalPageCrashWindowMs,
    );
    this.globalPageCrashTimestamps.push(nowMs);

    const channelNeedsRecycle =
      channelTimes.length >= this.channelCrashRecycleThreshold;
    const globalNeedsRecycle =
      this.globalPageCrashTimestamps.length >=
      this.globalPageCrashRecycleThreshold;

    if (!channelNeedsRecycle && !globalNeedsRecycle) {
      return;
    }

    const reason = channelNeedsRecycle
      ? 'channel_page_crash_loop'
      : 'global_page_crash_loop';
    this.logger.warn('browser_crash_loop_recycle_requested', {
      reason,
      channel,
      channelCrashCount: channelTimes.length,
      globalPageCrashCount: this.globalPageCrashTimestamps.length,
    });

    // Count crash-driven full recycle toward browser failure breaker.
    if (this.recordBrowserFailure()) {
      this.requestFatalRecovery('browser_crash_loop', {
        reason,
        channel,
      });
      return;
    }

    void this.restart().catch((error: unknown) => {
      this.logger.error('browser_crash_loop_recycle_failed', {
        reason,
        error: this.safeError(error),
      });
      this.requestFatalRecovery('browser_crash_loop_recycle_failed', {
        reason,
        channel,
      });
    });
  }

  private async processNavigationOutcomes(
    outcomes: readonly BrowserNavigationOutcome[],
    reportedRecoveryEpoch: number,
  ): Promise<void> {
    let decision: NavigationTimeoutRecoveryDecision | undefined;
    let escalateToContainer = false;

    await this.runExclusive(async () => {
      if (
        !this.desiredRunning ||
        this.browser === undefined ||
        this.context === undefined ||
        reportedRecoveryEpoch !== this.recoveryEpoch
      ) {
        return;
      }

      decision = this.recordNavigationOutcomes(outcomes);
      if (decision === undefined) {
        return;
      }

      this.clearNavigationTimeouts();
      escalateToContainer = this.recordBrowserFailure();
    });

    if (decision === undefined) {
      return;
    }

    this.logger.warn('browser_navigation_failure_recycle_requested', {
      ...decision,
    });

    if (escalateToContainer) {
      this.requestFatalRecovery('browser_navigation_failure_loop', {
        ...decision,
      });
      return;
    }

    try {
      await this.restart();
    } catch (error: unknown) {
      this.logger.error('browser_navigation_failure_recycle_failed', {
        reason: decision.reason,
        error: this.safeError(error),
      });
      this.requestFatalRecovery('browser_navigation_failure_recycle_failed', {
        reason: decision.reason,
        channel: decision.channel,
      });
    }
  }

  private recordNavigationOutcomes(
    outcomes: readonly BrowserNavigationOutcome[],
  ): NavigationTimeoutRecoveryDecision | undefined {
    const nowMs = this.now();
    this.globalNavigationTimeouts = this.globalNavigationTimeouts.filter(
      (entry) =>
        nowMs - entry.timestampMs <=
        DEFAULT_GLOBAL_NAVIGATION_TIMEOUT_WINDOW_MS,
    );

    for (const outcome of outcomes) {
      if (outcome.status === 'succeeded') {
        this.channelNavigationTimeoutTimestamps.delete(outcome.channel);
        this.globalNavigationTimeouts =
          this.globalNavigationTimeouts.filter(
            (entry) => entry.channel !== outcome.channel,
          );
        continue;
      }

      const channelTimes = evictOldTimestamps(
        this.channelNavigationTimeoutTimestamps.get(outcome.channel) ?? [],
        nowMs,
        DEFAULT_CHANNEL_NAVIGATION_TIMEOUT_WINDOW_MS,
      );
      channelTimes.push(nowMs);
      this.channelNavigationTimeoutTimestamps.set(
        outcome.channel,
        channelTimes,
      );
      this.globalNavigationTimeouts.push({
        channel: outcome.channel,
        timestampMs: nowMs,
      });

      const channelNeedsRecycle =
        channelTimes.length >=
        DEFAULT_CHANNEL_NAVIGATION_TIMEOUT_RECYCLE_THRESHOLD;
      const globalNeedsRecycle =
        this.globalNavigationTimeouts.length >=
        DEFAULT_GLOBAL_NAVIGATION_TIMEOUT_RECYCLE_THRESHOLD;

      this.logger.debug('browser_navigation_failure_recorded', {
        channel: outcome.channel,
        channelTimeoutCount: channelTimes.length,
        globalTimeoutCount: this.globalNavigationTimeouts.length,
      });

      if (channelNeedsRecycle || globalNeedsRecycle) {
        return {
          reason: channelNeedsRecycle
            ? 'channel_navigation_timeout_loop'
            : 'global_navigation_timeout_loop',
          channel: outcome.channel,
          channelTimeoutCount: channelTimes.length,
          globalTimeoutCount: this.globalNavigationTimeouts.length,
        };
      }
    }

    return undefined;
  }

  private clearNavigationTimeouts(): void {
    this.channelNavigationTimeoutTimestamps.clear();
    this.globalNavigationTimeouts = [];
  }

  /**
   * Record an unexpected browser failure. Returns true when container restart
   * should be requested instead of another browser recycle.
   */
  private recordBrowserFailure(): boolean {
    const nowMs = this.now();
    this.browserFailureTimestamps = evictOldTimestamps(
      this.browserFailureTimestamps,
      nowMs,
      this.browserFailureWindowMs,
    );
    this.browserFailureTimestamps.push(nowMs);
    return (
      this.browserFailureTimestamps.length >=
      this.browserFailureContainerThreshold
    );
  }

  private requestFatalRecovery(
    reason: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    const observer = this.onFatalRecovery;
    if (observer === undefined) {
      return;
    }
    void Promise.resolve()
      .then(() =>
        observer({
          reason,
          ...(fields === undefined ? {} : { fields }),
        }),
      )
      .catch((error: unknown) => {
        this.logger.error('browser_fatal_recovery_observer_failed', {
          reason,
          error: this.safeError(error),
        });
      });
  }

  private detachPageListeners(entry: PageEntry): void {
    entry.unsubscribeCrash();
    entry.unsubscribeClose();
    entry.unsubscribePopup();
    entry.unsubscribeCrash = () => undefined;
    entry.unsubscribeClose = () => undefined;
    entry.unsubscribePopup = () => undefined;
  }

  private async notifyInvalidations(
    channels: readonly string[],
    reason: BrowserInvalidationReason,
  ): Promise<void> {
    await Promise.all(
      channels.map((channel) =>
        this.notifyInvalidation({ channel, reason }),
      ),
    );
  }

  private async notifyInvalidation(
    invalidation: BrowserInvalidation,
  ): Promise<void> {
    if (this.onInvalidated === undefined) {
      return;
    }

    try {
      await this.onInvalidated(invalidation);
    } catch (error: unknown) {
      this.logger.error('browser_invalidation_observer_failed', {
        channel: invalidation.channel,
        reason: invalidation.reason,
        error: this.safeError(error),
      });
    }
  }

  private safeError(error: unknown): Readonly<{
    name: string;
    message: string;
  }> {
    const storageStatePath = this.config.storageStatePath;
    const input =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'Error', message: String(error) };

    const redactedMessage = redactSensitiveString(input.message);
    return {
      name: redactSensitiveString(input.name),
      message:
        storageStatePath.length === 0
          ? redactedMessage
          : redactedMessage.replaceAll(storageStatePath, '[REDACTED]'),
    };
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release = (): void => undefined;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function evictOldTimestamps(
  timestamps: readonly number[],
  nowMs: number,
  windowMs: number,
): number[] {
  const cutoff = nowMs - windowMs;
  return timestamps.filter((timestamp) => timestamp >= cutoff);
}
