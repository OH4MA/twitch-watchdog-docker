import type { Page } from 'playwright';

import {
  LOG_EVENTS,
  redactSensitiveString,
} from '../logging/Logger.js';
import { PlaywrightBrowserLauncher } from './adapters/PlaywrightBrowserLauncher.js';
import type {
  BrowserAdapter,
  BrowserContextAdapter,
  BrowserInvalidation,
  BrowserInvalidationObserver,
  BrowserInvalidationReason,
  BrowserLauncher,
  BrowserManager,
  BrowserManagerConfig,
  BrowserManagerDependencies,
  BrowserManagerLogger,
  BrowserPageAdapter,
  DetachedResources,
  PageEntry,
  RestartSchedule,
} from './types.js';

export { PlaywrightBrowserLauncher } from './adapters/PlaywrightBrowserLauncher.js';
export type {
  BrowserAdapter,
  BrowserContextAdapter,
  BrowserContextOptions,
  BrowserInvalidation,
  BrowserInvalidationObserver,
  BrowserInvalidationReason,
  BrowserLauncher,
  BrowserLaunchOptions,
  BrowserManager,
  BrowserManagerConfig,
  BrowserManagerDependencies,
  BrowserManagerLogger,
  BrowserPageAdapter,
  ResourceBlockingOptions,
} from './types.js';

const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const DEFAULT_RESTART_BACKOFF_MAX_MS = 30_000;
const DEFAULT_MAX_AUTOMATIC_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_ATTEMPT_RESET_MS = 60_000;

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
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly restartBackoffMs: number;
  private readonly restartBackoffMaxMs: number;
  private readonly maxAutomaticRestartAttempts: number;
  private readonly restartAttemptResetMs: number;

  private browser: BrowserAdapter | undefined;
  private context: BrowserContextAdapter | undefined;
  private unsubscribeBrowser: (() => void) | undefined;
  private readonly pages = new Map<string, PageEntry>();
  private operationTail: Promise<void> = Promise.resolve();
  private restartFlight: Promise<void> | undefined;
  private automaticRestartFlight: Promise<void> | undefined;
  private automaticRestartToken: symbol | undefined;
  private automaticRestartRecoveryEpoch: number | undefined;
  private desiredRunning = false;
  private recoveryEpoch = 0;
  private automaticRestartAttempts = 0;
  private lastBrowserCrashAt: number | undefined;

  public constructor(
    private readonly config: BrowserManagerConfig,
    dependencies: BrowserManagerDependencies = {},
  ) {
    this.launcher = dependencies.launcher ?? new PlaywrightBrowserLauncher();
    this.logger = dependencies.logger ?? NOOP_LOGGER;
    this.onInvalidated = dependencies.onInvalidated;
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
    return this.runExclusive(async () => {
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
    await this.runExclusive(async () => {
      const entry = this.pages.get(channel);
      if (entry === undefined) {
        return;
      }

      this.detachPageListeners(entry);

      try {
        await entry.adapter.close();
        if (this.pages.get(channel) === entry) {
          this.pages.delete(channel);
        }
      } catch (error: unknown) {
        if (entry.adapter.isClosed()) {
          this.pages.delete(channel);
        } else if (this.pages.get(channel) === entry) {
          this.reattachPageListeners(channel, entry);
        }

        this.logger.warn('browser_page_close_failed', {
          channel,
          error: this.safeError(error),
        });
        throw error;
      }
    });
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

  private async restartManually(): Promise<void> {
    const invalidatedChannels: string[] = [];

    try {
      await this.runExclusive(async () => {
        this.desiredRunning = true;
        this.recoveryEpoch += 1;
        this.automaticRestartAttempts = 0;
        this.lastBrowserCrashAt = undefined;
        invalidatedChannels.push(...this.pages.keys());

        const resources = this.detachResourcesUnlocked();
        await this.closeResourcesUnlocked(resources, 'restart');

        try {
          await this.startUnlocked();
        } catch (error: unknown) {
          this.logger.error('browser_restart_failed', {
            mode: 'manual',
            error: this.safeError(error),
          });
          throw error;
        }

        this.logger.warn(LOG_EVENTS.BROWSER_RESTARTED, {
          mode: 'manual',
          affectedChannelCount: invalidatedChannels.length,
        });
      });
    } finally {
      await this.notifyInvalidations(
        invalidatedChannels,
        'browser_restarted',
      );
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

      this.browser = browser;
      this.context = context;
      this.unsubscribeBrowser = unsubscribeBrowser;
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
    let shouldNotify: boolean;

    try {
      shouldNotify = await this.runExclusive(async () => {
        const entry = this.pages.get(channel);
        if (entry === undefined || entry.adapter !== adapter) {
          return false;
        }

        this.pages.delete(channel);
        this.detachPageListeners(entry);

        if (reason === 'page_crashed') {
          await this.closePageAdapterForCleanup(adapter, channel, 'crash');
        }

        this.logger.warn(reason, { channel });
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
    }
  }

  private async handleBrowserDisconnected(
    disconnectedBrowser: BrowserAdapter,
  ): Promise<void> {
    let invalidatedChannels: string[] = [];
    let restartSchedule: RestartSchedule | undefined;

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
          restartSchedule = this.nextRestartSchedule(recoveryEpoch, true);
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
        return;
      }

      this.logger.warn(LOG_EVENTS.BROWSER_RESTARTED, {
        mode: 'automatic',
        attempt: schedule.attempt,
      });
    });
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
  ): Promise<void> {
    for (const entry of resources.pages) {
      await this.closePageAdapterForCleanup(
        entry.adapter,
        undefined,
        phase,
      );
    }

    await this.closeResourceForCleanup(
      resources.context,
      'browser_context_close_failed',
      phase,
    );
    await this.closeResourceForCleanup(
      resources.browser,
      'browser_close_failed',
      phase,
    );
  }

  private async closePageAdapterForCleanup(
    adapter: BrowserPageAdapter,
    channel: string | undefined,
    phase: string,
  ): Promise<void> {
    if (adapter.isClosed()) {
      return;
    }

    try {
      await adapter.close();
    } catch (error: unknown) {
      this.logger.warn('browser_page_cleanup_failed', {
        ...(channel === undefined ? {} : { channel }),
        phase,
        error: this.safeError(error),
      });
    }
  }

  private async closeResourceForCleanup(
    resource: { close(): Promise<void> } | undefined,
    event: string,
    phase: string,
  ): Promise<void> {
    if (resource === undefined) {
      return;
    }

    try {
      await resource.close();
    } catch (error: unknown) {
      this.logger.warn(event, {
        phase,
        error: this.safeError(error),
      });
    }
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
