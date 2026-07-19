import {
  redactSensitiveString,
  type LogFields,
  type Logger,
} from '../logging/index.js';
import type {
  ChannelSession,
  ChannelSessionFactory,
  ChannelSessionPointsResult,
  ChannelSessionRefreshStatus,
} from '../browser/ChannelSession.js';

export type {
  ChannelSession,
  ChannelSessionFactory,
  ChannelSessionPointsResult,
  ChannelSessionRefreshStatus,
} from '../browser/ChannelSession.js';

export interface SessionManager {
  reconcile(activeChannels: readonly string[]): Promise<void>;
  stopAll(reason: string): Promise<void>;
  invalidate(channel: string, reason: string): Promise<void>;
  getActiveChannels(): string[];
  getRefreshStatuses(): readonly ChannelSessionRefreshStatus[];
  refreshPages(channel?: string): Promise<readonly SessionRefreshResult[]>;
  captureScreenshot(channel?: string): Promise<SessionScreenshot | undefined>;
  getChannelPoints(
    channel?: string,
  ): Promise<readonly SessionChannelPointsResult[]>;
}

export interface SessionRefreshResult {
  readonly channel: string;
  readonly status: 'refreshed' | 'unavailable' | 'failed';
  readonly error?: string;
}

export interface SessionScreenshot {
  readonly channel: string;
  readonly image: Buffer;
}

export type SessionChannelPointsResult =
  | {
      readonly channel: string;
      readonly status: 'available';
      readonly balance: number;
      readonly displayValue: string;
    }
  | {
      readonly channel: string;
      readonly status: 'unavailable';
      readonly reason:
        | Extract<
            ChannelSessionPointsResult,
            { status: 'unavailable' }
          >['reason']
        | 'failed';
    };

export type SessionManagerLogger = Pick<Logger, 'debug' | 'error' | 'warn'>;
export type SessionManagerSleep = (milliseconds: number) => Promise<void>;

export interface SessionManagerDependencies {
  readonly logger?: SessionManagerLogger;
  readonly sleep?: SessionManagerSleep;
  readonly startRetryAttempts?: number;
  readonly startRetryDelayMs?: number;
  readonly startStaggerMs?: number;
  readonly sessionOperationTimeoutMs?: number;
}

const NOOP_LOGGER: SessionManagerLogger = {
  debug(): void {},
  error(): void {},
  warn(): void {},
};
const DEFAULT_START_RETRY_ATTEMPTS = 0;
const DEFAULT_START_RETRY_DELAY_MS = 0;
const DEFAULT_START_STAGGER_MS = 0;
const DEFAULT_SESSION_OPERATION_TIMEOUT_MS = 60_000;

class SessionOperationTimeoutError extends Error {
  public constructor(
    public readonly event: string,
    timeoutMs: number,
  ) {
    super(`${event} after ${timeoutMs}ms`);
    this.name = 'SessionOperationTimeoutError';
  }
}

export class DefaultSessionManager implements SessionManager {
  private readonly sessions = new Map<string, ChannelSession>();
  private readonly logger: SessionManagerLogger;
  private readonly sleep: SessionManagerSleep;
  private readonly maxStartAttempts: number;
  private readonly startRetryDelayMs: number;
  private readonly startStaggerMs: number;
  private readonly sessionOperationTimeoutMs: number;
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly factory: ChannelSessionFactory,
    dependencies: SessionManagerDependencies = {},
  ) {
    this.logger = dependencies.logger ?? NOOP_LOGGER;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.maxStartAttempts =
      1 + normalizeNonNegativeInteger(
        dependencies.startRetryAttempts,
        DEFAULT_START_RETRY_ATTEMPTS,
      );
    this.startRetryDelayMs = normalizeNonNegativeInteger(
      dependencies.startRetryDelayMs,
      DEFAULT_START_RETRY_DELAY_MS,
    );
    this.startStaggerMs = normalizeNonNegativeInteger(
      dependencies.startStaggerMs,
      DEFAULT_START_STAGGER_MS,
    );
    this.sessionOperationTimeoutMs = normalizePositiveInteger(
      dependencies.sessionOperationTimeoutMs,
      DEFAULT_SESSION_OPERATION_TIMEOUT_MS,
    );
  }

  public async reconcile(activeChannels: readonly string[]): Promise<void> {
    const desiredChannels = uniqueChannels(activeChannels);
    const startedAtMs = Date.now();
    this.safeLog('debug', 'session_reconcile_started', {
      desiredChannels,
      activeBefore: this.getActiveChannels(),
    });

    await this.runExclusive(async () => {
      const desiredChannelSet = new Set(desiredChannels);
      let stoppedCount = 0;
      let startedCount = 0;

      for (const [channel, session] of [...this.sessions]) {
        if (desiredChannelSet.has(channel)) {
          continue;
        }

        this.sessions.delete(channel);
        await this.stopSession(session, channel, 'inactive');
        stoppedCount += 1;
      }

      let hasAttemptedStart = false;
      for (const channel of desiredChannels) {
        if (this.sessions.has(channel)) {
          continue;
        }

        if (hasAttemptedStart && this.startStaggerMs > 0) {
          await this.sleep(this.startStaggerMs);
        }

        await this.startSession(channel);
        if (this.sessions.has(channel)) {
          startedCount += 1;
        }
        hasAttemptedStart = true;
      }

      this.reorderSessions(desiredChannels);
      this.safeLog('debug', 'session_reconcile_completed', {
        desiredChannels,
        activeAfter: this.getActiveChannels(),
        stoppedCount,
        startedCount,
        durationMs: Date.now() - startedAtMs,
      });
    });
  }

  public async stopAll(reason: string): Promise<void> {
    await this.runExclusive(async () => {
      const sessions = [...this.sessions];
      this.sessions.clear();

      for (const [channel, session] of sessions) {
        await this.stopSession(session, channel, reason);
      }
    });
  }

  public async invalidate(channel: string, reason: string): Promise<void> {
    const startedAtMs = Date.now();
    this.safeLog('debug', 'session_invalidate_started', {
      channel,
      reason,
      activeBefore: this.getActiveChannels(),
    });

    await this.runExclusive(async () => {
      const session = this.sessions.get(channel);
      if (session === undefined) {
        this.safeLog('debug', 'session_invalidate_completed', {
          channel,
          reason,
          removed: false,
          activeAfter: this.getActiveChannels(),
          durationMs: Date.now() - startedAtMs,
        });
        return;
      }

      this.sessions.delete(channel);
      await this.stopSession(session, channel, reason);
      this.safeLog('debug', 'session_invalidate_completed', {
        channel,
        reason,
        removed: true,
        activeAfter: this.getActiveChannels(),
        durationMs: Date.now() - startedAtMs,
      });
    });
  }

  public getActiveChannels(): string[] {
    return [...this.sessions.keys()];
  }

  public getRefreshStatuses(): readonly ChannelSessionRefreshStatus[] {
    return [...this.sessions.values()].map((session) =>
      session.getRefreshStatus(),
    );
  }

  public async refreshPages(
    requestedChannel?: string,
  ): Promise<readonly SessionRefreshResult[]> {
    const entries = requestedChannel === undefined
      ? [...this.sessions]
      : optionalEntry(findSession(this.sessions, requestedChannel));

    const results: SessionRefreshResult[] = [];
    for (const [channel, session] of entries) {
      try {
        const refreshed = await session.refreshNow();
        results.push({
          channel,
          status: refreshed ? 'refreshed' : 'unavailable',
        });
      } catch (error: unknown) {
        const safeError = safeErrorMessage(error);
        this.safeLog('warn', 'session_manual_refresh_failed', {
          channel,
          error: safeError,
        });
        results.push({
          channel,
          status: 'failed',
          error: safeError,
        });
      }
    }
    return results;
  }

  public async captureScreenshot(
    requestedChannel?: string,
  ): Promise<SessionScreenshot | undefined> {
    const entries = requestedChannel === undefined
      ? [...this.sessions]
      : optionalEntry(findSession(this.sessions, requestedChannel));

    for (const [channel, session] of entries) {
      try {
        return {
          channel,
          image: await session.captureScreenshot(),
        };
      } catch (error: unknown) {
        this.safeLog('warn', 'session_screenshot_failed', {
          channel,
          error: safeErrorMessage(error),
        });
      }
    }

    return undefined;
  }

  public async getChannelPoints(
    requestedChannel?: string,
  ): Promise<readonly SessionChannelPointsResult[]> {
    const entries = requestedChannel === undefined
      ? [...this.sessions]
      : optionalEntry(findSession(this.sessions, requestedChannel));
    const results: SessionChannelPointsResult[] = [];

    for (const [channel, session] of entries) {
      try {
        const result = await session.getChannelPoints();
        results.push({ channel, ...result });
      } catch (error: unknown) {
        this.safeLog('warn', 'session_channel_points_failed', {
          channel,
          error: safeErrorMessage(error),
        });
        results.push({ channel, status: 'unavailable', reason: 'failed' });
      }
    }

    return results;
  }

  private async startSession(channel: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxStartAttempts; attempt += 1) {
      let session: ChannelSession | undefined;
      const startedAtMs = Date.now();

      try {
        this.safeLog('debug', 'session_start_attempt_started', {
          channel,
          attempt,
          maxAttempts: this.maxStartAttempts,
        });
        session = await this.factory.create(channel);
        await this.withSessionOperationTimeout(
          session.start(),
          'session_start_timeout',
          { channel, attempt },
        );
        this.sessions.set(channel, session);
        this.safeLog('debug', 'session_start_attempt_completed', {
          channel,
          attempt,
          durationMs: Date.now() - startedAtMs,
        });
        return;
      } catch (error: unknown) {
        const safeError = safeErrorMessage(error);

        if (session !== undefined) {
          if (
            error instanceof SessionOperationTimeoutError &&
            error.event === 'session_start_timeout'
          ) {
            await this.cancelTimedOutStart(session, channel);
          }
          await this.cleanupFailedStart(session, channel);
        }

        const shouldRetry =
          attempt < this.maxStartAttempts &&
          isRetriableSessionStartError(safeError);

        if (!shouldRetry) {
          this.safeLog('error', 'session_start_failed', {
            channel,
            error: safeError,
          });
          return;
        }

        this.safeLog('warn', 'session_start_retry_scheduled', {
          channel,
          attempt,
          retryInMs: this.startRetryDelayMs,
          error: safeError,
        });

        if (this.startRetryDelayMs > 0) {
          await this.sleep(this.startRetryDelayMs);
        }
      }
    }
  }

  private async cancelTimedOutStart(
    session: ChannelSession,
    channel: string,
  ): Promise<void> {
    if (session.cancelStart === undefined) {
      return;
    }

    try {
      await this.withSessionOperationTimeout(
        session.cancelStart('start_timeout'),
        'session_start_cancel_timeout',
        { channel },
      );
    } catch (error: unknown) {
      this.safeLog('warn', 'session_start_cancel_failed', {
        channel,
        error: safeErrorMessage(error),
      });
    }
  }

  private async cleanupFailedStart(
    session: ChannelSession,
    channel: string,
  ): Promise<void> {
    await this.stopSession(session, channel, 'start_failed');
  }

  private async stopSession(
    session: ChannelSession,
    channel: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.withSessionOperationTimeout(
        session.stop(reason),
        'session_stop_timeout',
        { channel, reason },
      );
    } catch (error: unknown) {
      this.safeLog('warn', 'session_stop_failed', {
        channel,
        reason,
        error: safeErrorMessage(error),
      });
    }
  }

  private async withSessionOperationTimeout<T>(
    operation: Promise<T>,
    timeoutEvent: string,
    fields: LogFields,
  ): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    operation.catch(() => undefined);

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        this.safeLog('warn', timeoutEvent, {
          ...fields,
          timeoutMs: this.sessionOperationTimeoutMs,
        });
        reject(
          new SessionOperationTimeoutError(
            timeoutEvent,
            this.sessionOperationTimeoutMs,
          ),
        );
      }, this.sessionOperationTimeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private reorderSessions(desiredChannels: readonly string[]): void {
    const orderedSessions = desiredChannels.flatMap((channel) => {
      const session = this.sessions.get(channel);
      return session === undefined ? [] : [[channel, session] as const];
    });

    this.sessions.clear();
    for (const [channel, session] of orderedSessions) {
      this.sessions.set(channel, session);
    }
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private safeLog(
    level: keyof SessionManagerLogger,
    event: string,
    fields: LogFields,
  ): void {
    try {
      this.logger[level](event, fields);
    } catch {
      // Logging failure must not break session lifecycle cleanup.
    }
  }
}

function uniqueChannels(channels: readonly string[]): string[] {
  return [...new Set(channels)];
}

function findSession(
  sessions: ReadonlyMap<string, ChannelSession>,
  requestedChannel: string,
): readonly [string, ChannelSession] | undefined {
  const normalized = requestedChannel.trim().toLocaleLowerCase('en-US');
  return [...sessions].find(
    ([channel]) => channel.toLocaleLowerCase('en-US') === normalized,
  );
}

function optionalEntry(
  entry: readonly [string, ChannelSession] | undefined,
): readonly (readonly [string, ChannelSession])[] {
  return entry === undefined ? [] : [entry];
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    Math.trunc(value) <= 0
  ) {
    return fallback;
  }

  return Math.trunc(value);
}

function isRetriableSessionStartError(message: string): boolean {
  return /Target page, context or browser has been closed/iu.test(message) ||
    /browser(?: manager)? (?:has been )?closed/iu.test(message) ||
    /context .*closed/iu.test(message) ||
    /page .*closed/iu.test(message) ||
    /page\.goto: Timeout \d+ms exceeded/iu.test(message) ||
    /Browser Manager 尚未啟動/iu.test(message);
}

function safeErrorMessage(error: unknown): string {
  let message = 'Unknown session lifecycle failure';

  try {
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error !== undefined && error !== null) {
      message = String(error);
    }
  } catch {
    message = 'Unserializable session lifecycle failure';
  }

  return redactSensitiveString(message);
}
