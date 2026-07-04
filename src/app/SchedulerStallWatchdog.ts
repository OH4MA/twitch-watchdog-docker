import type { Logger } from '../logging/index.js';
import type { WatchdogScheduler } from '../scheduler/index.js';
import type { ApplicationIntegration } from './AppRunner.js';

export interface SchedulerStallWatchdogOptions {
  readonly scheduler: Pick<WatchdogScheduler, 'getSnapshot'>;
  readonly logger: Pick<Logger, 'error' | 'info' | 'flush'>;
  readonly intervalSeconds: number;
  readonly stallThresholdMs: number;
  readonly now?: () => number;
  readonly exit?: (code: number) => void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class SchedulerStallWatchdog implements ApplicationIntegration {
  private readonly now: () => number;
  private readonly exit: (code: number) => void;
  private timer: NodeJS.Timeout | undefined;
  private inFlightSinceMs: number | undefined;
  private exitRequested = false;

  public constructor(
    private readonly options: SchedulerStallWatchdogOptions,
  ) {
    if (
      !Number.isSafeInteger(options.intervalSeconds) ||
      options.intervalSeconds <= 0
    ) {
      throw new TypeError('intervalSeconds must be a positive integer');
    }
    if (
      !Number.isSafeInteger(options.stallThresholdMs) ||
      options.stallThresholdMs <= 0
    ) {
      throw new TypeError('stallThresholdMs must be a positive integer');
    }

    this.now = options.now ?? (() => Date.now());
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  public async start(): Promise<void> {
    if (this.timer !== undefined) {
      return;
    }

    this.options.logger.info('scheduler_stall_watchdog_started', {
      intervalSeconds: this.options.intervalSeconds,
      stallThresholdMs: this.options.stallThresholdMs,
    });
    this.check();
    this.timer = setInterval(
      () => {
        this.check();
      },
      Math.min(
        MAX_TIMER_DELAY_MS,
        this.options.intervalSeconds * 1_000,
      ),
    );
    this.timer.unref?.();
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.inFlightSinceMs = undefined;
  }

  private check(): void {
    if (this.exitRequested) {
      return;
    }

    const snapshot = this.options.scheduler.getSnapshot();
    const nowMs = this.now();
    if (!snapshot.checkInFlight) {
      this.inFlightSinceMs = undefined;
      return;
    }

    this.inFlightSinceMs ??= nowMs;
    const inFlightDurationMs = nowMs - this.inFlightSinceMs;
    if (inFlightDurationMs < this.options.stallThresholdMs) {
      return;
    }

    this.exitRequested = true;
    this.options.logger.error('scheduler_stall_detected', {
      inFlightDurationMs,
      stallThresholdMs: this.options.stallThresholdMs,
      running: snapshot.running,
      lastCheckedAt: snapshot.lastCheckedAt,
      retryAt: snapshot.retryAt,
    });

    void this.options.logger.flush()
      .catch(() => undefined)
      .finally(() => {
        this.exit(1);
      });
  }
}
