import type { AppConfig } from '../config/index.js';
import type { RuntimeWatchConfig } from '../config/index.js';
import { LOG_EVENTS, type Logger } from '../logging/index.js';
import {
  TwitchApiAuthError,
  TwitchApiRateLimitError,
  TwitchApiTemporaryError,
  type ChannelLiveStatus,
  type LiveStatusProvider,
} from '../twitch/index.js';
import type { SessionManager } from '../sessions/index.js';
import type { StreamSelector } from './StreamSelector.js';

export interface WatchdogScheduler {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
  getSnapshot(): WatchdogSchedulerSnapshot;
  updateConfig(config: RuntimeWatchConfig): Promise<void>;
}

export interface WatchdogSchedulerSnapshot {
  readonly running: boolean;
  readonly checkInFlight: boolean;
  readonly retryAt?: string;
  readonly lastCheckedAt?: string;
  readonly channels: readonly SchedulerChannelStatus[];
}

export interface SchedulerChannelStatus {
  readonly channel: string;
  readonly isLive?: boolean;
}

export interface StreamStatusChange {
  readonly channel: string;
  readonly isLive: boolean;
}

export type StreamStatusObserver = (
  change: StreamStatusChange,
) => void | Promise<void>;

export interface SchedulerTimer {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export type WatchdogSchedulerConfig = Pick<
  AppConfig,
  'channels' | 'checkIntervalSeconds' | 'maxConcurrentStreams'
>;

export interface DefaultWatchdogSchedulerOptions {
  readonly config: WatchdogSchedulerConfig;
  readonly liveStatusProvider: LiveStatusProvider;
  readonly streamSelector: StreamSelector;
  readonly sessionManager: SessionManager;
  readonly logger: Logger;
  readonly timer?: SchedulerTimer;
  readonly now?: () => Date;
  readonly onStreamStatusChanged?: StreamStatusObserver;
}

const NO_INTERVAL = Symbol('no interval');

const DEFAULT_TIMER: SchedulerTimer = {
  setInterval(callback: () => void, intervalMs: number): unknown {
    return globalThis.setInterval(callback, intervalMs);
  },
  clearInterval(handle: unknown): void {
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export class DefaultWatchdogScheduler implements WatchdogScheduler {
  private readonly timer: SchedulerTimer;
  private readonly now: () => Date;
  private readonly previousLiveStatuses = new Map<string, boolean>();
  private intervalHandle: unknown = NO_INTERVAL;
  private inFlight: Promise<void> | undefined;
  private retryAt: Date | undefined;
  private lastCheckedAt: Date | undefined;
  private started = false;
  private runtimeConfig: RuntimeWatchConfig;

  public constructor(
    private readonly options: DefaultWatchdogSchedulerOptions,
  ) {
    this.timer = options.timer ?? DEFAULT_TIMER;
    this.now = options.now ?? (() => new Date());
    this.runtimeConfig = freezeRuntimeConfig(options.config);
  }

  public start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.intervalHandle = this.timer.setInterval(
      () => {
        if (this.started) {
          this.triggerTick();
        }
      },
      this.options.config.checkIntervalSeconds * 1_000,
    );
    this.triggerTick();
  }

  public async stop(): Promise<void> {
    this.started = false;

    if (this.intervalHandle !== NO_INTERVAL) {
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = NO_INTERVAL;
    }

    await this.inFlight;
  }

  public runOnce(): Promise<void> {
    if (this.inFlight !== undefined) {
      this.options.logger.warn('scheduler_tick_skipped', {
        reason: 'in_flight',
      });
      return Promise.resolve();
    }

    if (this.isRateLimited()) {
      this.options.logger.warn('scheduler_tick_skipped', {
        reason: 'rate_limited',
        retryAt: this.retryAt?.toISOString(),
      });
      return Promise.resolve();
    }

    const execution = this.executeTick();
    const trackedExecution = execution.finally(() => {
      if (this.inFlight === trackedExecution) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = trackedExecution;

    return trackedExecution;
  }

  public getSnapshot(): WatchdogSchedulerSnapshot {
    return {
      running: this.started,
      checkInFlight: this.inFlight !== undefined,
      ...(this.retryAt === undefined
        ? {}
        : { retryAt: this.retryAt.toISOString() }),
      ...(this.lastCheckedAt === undefined
        ? {}
        : { lastCheckedAt: this.lastCheckedAt.toISOString() }),
      channels: this.runtimeConfig.channels.map((channel) => {
        const isLive = this.previousLiveStatuses.get(
          normalizeChannel(channel),
        );
        return isLive === undefined ? { channel } : { channel, isLive };
      }),
    };
  }

  public async updateConfig(config: RuntimeWatchConfig): Promise<void> {
    await this.inFlight;
    this.runtimeConfig = freezeRuntimeConfig(config);

    const configured = new Set(
      this.runtimeConfig.channels.map((channel) => normalizeChannel(channel)),
    );
    for (const channel of [...this.previousLiveStatuses.keys()]) {
      if (!configured.has(channel)) {
        this.previousLiveStatuses.delete(channel);
      }
    }

    const knownStatuses: ChannelLiveStatus[] =
      this.runtimeConfig.channels.map((channel) => ({
        channel,
        isLive:
          this.previousLiveStatuses.get(normalizeChannel(channel)) === true,
        checkedAt:
          this.lastCheckedAt?.toISOString() ?? this.now().toISOString(),
      }));
    const activeChannels =
      this.options.streamSelector.selectActiveChannels({
        configuredChannels: this.runtimeConfig.channels,
        liveStatuses: knownStatuses,
        maxConcurrentStreams: this.runtimeConfig.maxConcurrentStreams,
      });
    await this.options.sessionManager.reconcile(activeChannels);
    await this.runOnce();
  }

  private triggerTick(): void {
    void this.runOnce().catch(() => {
      this.options.logger.error('scheduler_tick_failed', {
        reason: 'unexpected_error',
      });
    });
  }

  private async executeTick(): Promise<void> {
    let liveStatuses: ChannelLiveStatus[];

    try {
      liveStatuses =
        await this.options.liveStatusProvider.getLiveStatuses(
          this.runtimeConfig.channels,
        );
    } catch (error: unknown) {
      this.handleApiError(error);
      return;
    }

    const currentLiveStatuses =
      this.collectConfiguredLiveStatuses(liveStatuses);
    if (currentLiveStatuses === undefined) {
      this.options.logger.warn('twitch_api_temporary_error', {
        reason: 'invalid-response',
      });
      return;
    }

    this.logStatusChanges(currentLiveStatuses);
    this.replacePreviousStatuses(currentLiveStatuses);
    this.lastCheckedAt = this.now();
    this.retryAt = undefined;

    const activeChannels =
      this.options.streamSelector.selectActiveChannels({
        configuredChannels: this.runtimeConfig.channels,
        liveStatuses,
        maxConcurrentStreams:
          this.runtimeConfig.maxConcurrentStreams,
      });

    await this.options.sessionManager.reconcile(activeChannels);
  }

  private isRateLimited(): boolean {
    if (this.retryAt === undefined) {
      return false;
    }

    if (this.now().getTime() >= this.retryAt.getTime()) {
      this.retryAt = undefined;
      return false;
    }

    return true;
  }

  private handleApiError(error: unknown): void {
    if (error instanceof TwitchApiRateLimitError) {
      if (
        this.retryAt === undefined ||
        error.retryAt.getTime() > this.retryAt.getTime()
      ) {
        this.retryAt = error.retryAt;
      }

      this.options.logger.warn('twitch_api_rate_limited', {
        retryAt: error.retryAt.toISOString(),
        retryAfterMs: error.retryAfterMs,
      });
      return;
    }

    if (error instanceof TwitchApiAuthError) {
      this.options.logger.error(LOG_EVENTS.TWITCH_API_AUTH_FAILED, {
        statusCode: error.statusCode,
      });
      return;
    }

    if (error instanceof TwitchApiTemporaryError) {
      const fields: Record<string, unknown> = {
        reason: error.reason,
      };
      if (error.statusCode !== undefined) {
        fields.statusCode = error.statusCode;
      }
      this.options.logger.warn('twitch_api_temporary_error', fields);
      return;
    }

    this.options.logger.warn('twitch_api_request_failed', {
      kind: 'unknown',
    });
  }

  private collectConfiguredLiveStatuses(
    liveStatuses: readonly ChannelLiveStatus[],
  ): ReadonlyMap<string, boolean> | undefined {
    const statusesByChannel = new Map<string, boolean>();

    for (const status of liveStatuses) {
      const channel = normalizeChannel(status.channel);
      const previous = statusesByChannel.get(channel);
      statusesByChannel.set(
        channel,
        previous === undefined
          ? status.isLive
          : previous && status.isLive,
      );
    }

    for (const channel of this.runtimeConfig.channels) {
      if (!statusesByChannel.has(normalizeChannel(channel))) {
        return undefined;
      }
    }

    return statusesByChannel;
  }

  private logStatusChanges(
    currentLiveStatuses: ReadonlyMap<string, boolean>,
  ): void {
    const loggedChannels = new Set<string>();
    for (const channel of this.runtimeConfig.channels) {
      const normalizedChannel = normalizeChannel(channel);
      if (loggedChannels.has(normalizedChannel)) {
        continue;
      }
      loggedChannels.add(normalizedChannel);

      const isLive = currentLiveStatuses.get(normalizedChannel);
      const wasLive = this.previousLiveStatuses.get(normalizedChannel);

      if (isLive === true && wasLive !== true) {
        this.options.logger.info(LOG_EVENTS.STREAM_ONLINE, {
          channel,
        });
        this.notifyStatusChange({ channel, isLive: true });
      } else if (isLive === false && wasLive === true) {
        this.options.logger.info(LOG_EVENTS.STREAM_OFFLINE, {
          channel,
        });
        this.notifyStatusChange({ channel, isLive: false });
      }
    }
  }

  private notifyStatusChange(change: StreamStatusChange): void {
    try {
      void Promise.resolve(
        this.options.onStreamStatusChanged?.(change),
      ).catch(() => {
        this.options.logger.warn('stream_status_notification_failed', {
          channel: change.channel,
        });
      });
    } catch {
      this.options.logger.warn('stream_status_notification_failed', {
        channel: change.channel,
      });
    }
  }

  private replacePreviousStatuses(
    currentLiveStatuses: ReadonlyMap<string, boolean>,
  ): void {
    this.previousLiveStatuses.clear();

    for (const [channel, isLive] of currentLiveStatuses) {
      this.previousLiveStatuses.set(channel, isLive);
    }
  }
}

function normalizeChannel(channel: string): string {
  return channel.toLocaleLowerCase('en-US');
}

function freezeRuntimeConfig(
  config: RuntimeWatchConfig,
): RuntimeWatchConfig {
  return Object.freeze({
    channels: Object.freeze([...config.channels]),
    maxConcurrentStreams: config.maxConcurrentStreams,
  });
}
