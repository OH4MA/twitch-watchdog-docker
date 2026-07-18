import type { Logger } from '../logging/index.js';
import { LOG_EVENTS } from '../logging/Logger.js';

export interface ContainerRestartRequest {
  readonly reason: string;
  readonly source: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export type ContainerRestartNotifyObserver = (
  request: ContainerRestartRequest,
) => Promise<void> | void;

export interface ContainerRestartControllerOptions {
  readonly logger: Pick<Logger, 'error' | 'flush'>;
  readonly exit?: (code: number) => void;
  readonly flushTimeoutMs?: number;
  /** Best-effort bot / external notify before exit. Bounded by notifyTimeoutMs. */
  readonly onNotify?: ContainerRestartNotifyObserver;
  readonly notifyTimeoutMs?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
const DEFAULT_NOTIFY_TIMEOUT_MS = 3_000;

/**
 * Single-flight fatal exit: first request wins, bounded logger flush, then exit(1).
 * Used by resource guard, scheduler stall, reward escalation, and browser fatal paths.
 */
export class ContainerRestartController {
  private readonly logger: Pick<Logger, 'error' | 'flush'>;
  private readonly exit: (code: number) => void;
  private readonly flushTimeoutMs: number;
  private readonly onNotify: ContainerRestartNotifyObserver | undefined;
  private readonly notifyTimeoutMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private flight: Promise<void> | undefined;

  public constructor(options: ContainerRestartControllerOptions) {
    this.logger = options.logger;
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.flushTimeoutMs = positiveInteger(
      options.flushTimeoutMs,
      DEFAULT_FLUSH_TIMEOUT_MS,
    );
    this.onNotify = options.onNotify;
    this.notifyTimeoutMs = positiveInteger(
      options.notifyTimeoutMs,
      DEFAULT_NOTIFY_TIMEOUT_MS,
    );
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  public isRestartInFlight(): boolean {
    return this.flight !== undefined;
  }

  /**
   * Request a container restart. Concurrent callers share the same flight.
   * Never throws; handler failures are logged and exit still proceeds.
   */
  public request(request: ContainerRestartRequest): Promise<void> {
    if (this.flight !== undefined) {
      return this.flight;
    }

    const flight = this.execute(request).catch((error: unknown) => {
      // Last-resort: still try to exit if execute itself failed unexpectedly.
      try {
        this.logger.error('container_restart_controller_failed', {
          reason: request.reason,
          source: request.source,
          error: error instanceof Error ? error.message : 'unknown error',
        });
      } catch {
        // ignore logger failures
      }
      try {
        this.exit(1);
      } catch {
        // ignore exit failures in tests that throw
      }
    });
    this.flight = flight;
    return flight;
  }

  private async execute(request: ContainerRestartRequest): Promise<void> {
    const fields = sanitizeFields(request.fields);
    this.logger.error(LOG_EVENTS.CONTAINER_RESTART_REQUESTED, {
      reason: request.reason,
      source: request.source,
      ...fields,
    });

    await this.notifyWithTimeout(request);
    await this.flushWithTimeout();
    this.exit(1);
  }

  private async notifyWithTimeout(
    request: ContainerRestartRequest,
  ): Promise<void> {
    const observer = this.onNotify;
    if (observer === undefined) {
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve()
          .then(() => observer(request))
          .catch(() => undefined),
        new Promise<void>((resolve) => {
          timeoutHandle = this.setTimeoutFn(() => {
            resolve();
          }, this.notifyTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle !== undefined) {
        this.clearTimeoutFn(timeoutHandle);
      }
    }
  }

  private async flushWithTimeout(): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve()
          .then(() => this.logger.flush())
          .catch(() => undefined),
        new Promise<void>((resolve) => {
          timeoutHandle = this.setTimeoutFn(() => {
            resolve();
          }, this.flushTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle !== undefined) {
        this.clearTimeoutFn(timeoutHandle);
      }
    }
  }
}

function sanitizeFields(
  fields: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (fields === undefined) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    // Reject nested objects that might accidentally carry secrets.
    if (value !== null && typeof value === 'object') {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return fallback;
  }
  return value;
}
