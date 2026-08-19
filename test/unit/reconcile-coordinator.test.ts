import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/logging/index.js';
import { DefaultReconcileCoordinator } from '../../src/sessions/index.js';

describe('DefaultReconcileCoordinator', () => {
  it('進行中的 reconcile 保留，尚未處理的 desired state 只保留最新一筆', async () => {
    const firstGate = deferred<void>();
    const reconcile = vi.fn(async (channels: readonly string[]) => {
      if (channels[0] === 'first') {
        await firstGate.promise;
      }
    });
    const logger = createLogger();
    const coordinator = new DefaultReconcileCoordinator({
      sessionManager: { reconcile },
      logger,
    });

    coordinator.request(['first']);
    await vi.waitFor(() => {
      expect(reconcile).toHaveBeenCalledWith(['first']);
    });
    coordinator.request(['stale']);
    coordinator.request(['latest']);

    firstGate.resolve(undefined);
    await coordinator.waitForIdle();

    expect(reconcile.mock.calls).toEqual([[['first']], [['latest']]]);
    expect(logger.debug).toHaveBeenCalledWith(
      'reconcile_coalesced',
      expect.objectContaining({ desiredChannels: ['latest'] }),
    );
  });

  it('shutdown 停止接收新 request 並只等待有限 grace period', async () => {
    vi.useFakeTimers();
    try {
      const reconcileGate = deferred<void>();
      const reconcile = vi.fn(async () => reconcileGate.promise);
      const cancelPendingStarts = vi.fn(async () => undefined);
      const coordinator = new DefaultReconcileCoordinator({
        sessionManager: { reconcile, cancelPendingStarts },
        logger: createLogger(),
        shutdownTimeoutMs: 500,
      });

      coordinator.request(['active']);
      await vi.waitFor(() => {
        expect(reconcile).toHaveBeenCalledOnce();
      });
      const stop = coordinator.stop('shutdown');
      coordinator.request(['ignored']);

      await vi.advanceTimersByTimeAsync(500);
      await expect(stop).resolves.toBeUndefined();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(cancelPendingStarts).toHaveBeenCalledWith('shutdown');

      reconcileGate.resolve(undefined);
      await coordinator.waitForIdle();
    } finally {
      vi.useRealTimers();
    }
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createLogger(): Pick<Logger, 'debug' | 'error'> {
  return {
    debug: vi.fn(),
    error: vi.fn(),
  };
}
