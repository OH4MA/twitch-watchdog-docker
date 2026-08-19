import {
  redactSensitiveString,
  type Logger,
} from '../logging/index.js';
import type { SessionManager } from './SessionManager.js';

export interface ReconcileCoordinator {
  request(desiredChannels: readonly string[]): void;
  stop(reason: string): Promise<void>;
  waitForIdle(): Promise<void>;
}

export interface ReconcileCoordinatorOptions {
  readonly sessionManager: Pick<SessionManager, 'reconcile'> &
    Partial<Pick<SessionManager, 'cancelPendingStarts'>>;
  readonly logger: Pick<Logger, 'debug' | 'error'>;
  readonly now?: () => number;
  readonly shutdownTimeoutMs?: number;
}

interface ReconcileRequest {
  readonly id: number;
  readonly desiredChannels: readonly string[];
  readonly requestedAtMs: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export class DefaultReconcileCoordinator implements ReconcileCoordinator {
  private readonly now: () => number;
  private readonly shutdownTimeoutMs: number;
  private pending: ReconcileRequest | undefined;
  private workerFlight: Promise<void> | undefined;
  private accepting = true;
  private sequence = 0;

  public constructor(private readonly options: ReconcileCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.shutdownTimeoutMs = Math.max(
      1,
      Math.trunc(options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS),
    );
  }

  public request(desiredChannels: readonly string[]): void {
    if (!this.accepting) {
      return;
    }

    const request: ReconcileRequest = {
      id: this.nextId(),
      desiredChannels: Object.freeze([...new Set(desiredChannels)]),
      requestedAtMs: this.now(),
    };
    const replaced = this.pending;
    this.pending = request;
    this.options.logger.debug('reconcile_requested', {
      reconcileId: request.id,
      desiredChannels: request.desiredChannels,
    });
    if (replaced !== undefined) {
      this.options.logger.debug('reconcile_coalesced', {
        reconcileId: request.id,
        replacedReconcileId: replaced.id,
        desiredChannels: request.desiredChannels,
      });
    }
    this.startWorker();
  }

  public async waitForIdle(): Promise<void> {
    while (this.workerFlight !== undefined) {
      await this.workerFlight;
    }
  }

  public async stop(reason: string): Promise<void> {
    this.accepting = false;
    this.pending = undefined;
    const worker = this.workerFlight;
    const cancellation = this.options.sessionManager.cancelPendingStarts?.(
      reason,
    ) ?? Promise.resolve();

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, this.shutdownTimeoutMs);
      timeoutHandle.unref?.();
    });
    await Promise.race([
      Promise.all([worker ?? Promise.resolve(), cancellation]),
      timeout,
    ]);
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  private startWorker(): void {
    if (this.workerFlight !== undefined) {
      return;
    }
    const flight = this.drain().finally(() => {
      if (this.workerFlight === flight) {
        this.workerFlight = undefined;
      }
      if (this.accepting && this.pending !== undefined) {
        this.startWorker();
      }
    });
    this.workerFlight = flight;
  }

  private async drain(): Promise<void> {
    while (this.accepting && this.pending !== undefined) {
      const request = this.pending;
      this.pending = undefined;
      const startedAtMs = this.now();
      this.options.logger.debug('reconcile_started', {
        reconcileId: request.id,
        desiredChannels: request.desiredChannels,
        queuedMs: Math.max(0, startedAtMs - request.requestedAtMs),
      });
      try {
        await this.options.sessionManager.reconcile(request.desiredChannels);
        this.options.logger.debug('reconcile_completed', {
          reconcileId: request.id,
          desiredChannels: request.desiredChannels,
          outcome: 'completed',
          durationMs: Math.max(0, this.now() - startedAtMs),
        });
      } catch (error: unknown) {
        this.options.logger.error('reconcile_completed', {
          reconcileId: request.id,
          desiredChannels: request.desiredChannels,
          outcome: 'failed',
          durationMs: Math.max(0, this.now() - startedAtMs),
          error: safeErrorMessage(error),
        });
      }
    }
  }

  private nextId(): number {
    this.sequence = (this.sequence % Number.MAX_SAFE_INTEGER) + 1;
    return this.sequence;
  }
}

function safeErrorMessage(error: unknown): string {
  return redactSensitiveString(
    error instanceof Error ? error.message : String(error),
  );
}
