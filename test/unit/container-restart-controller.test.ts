import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContainerRestartController } from '../../src/app/ContainerRestartController.js';
import { LOG_EVENTS } from '../../src/logging/Logger.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ContainerRestartController', () => {
  it('第一次 request 會 emit 一次事件、flush 後 exit(1)', async () => {
    const error = vi.fn();
    const flush = vi.fn(async () => undefined);
    const exit = vi.fn();
    const controller = new ContainerRestartController({
      logger: { error, flush },
      exit,
    });

    await controller.request({
      reason: 'emergency_memory',
      source: 'resource_guard',
      fields: { memoryCurrentBytes: 1_000 },
    });

    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(LOG_EVENTS.CONTAINER_RESTART_REQUESTED, {
      reason: 'emergency_memory',
      source: 'resource_guard',
      memoryCurrentBytes: 1_000,
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('多來源同時 request 仍只 exit 一次', async () => {
    const error = vi.fn();
    const flush = vi.fn(async () => undefined);
    const exit = vi.fn();
    const controller = new ContainerRestartController({
      logger: { error, flush },
      exit,
    });

    await Promise.all([
      controller.request({ reason: 'a', source: 'one' }),
      controller.request({ reason: 'b', source: 'two' }),
      controller.request({ reason: 'c', source: 'three' }),
    ]);

    expect(error).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('flush 逾時仍會 exit', async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const flush = vi.fn(
      () => new Promise<void>(() => undefined),
    );
    const exit = vi.fn();
    const controller = new ContainerRestartController({
      logger: { error, flush },
      exit,
      flushTimeoutMs: 100,
    });

    const requestPromise = controller.request({
      reason: 'stall',
      source: 'scheduler',
    });
    await vi.advanceTimersByTimeAsync(100);
    await requestPromise;

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('flush 失敗仍會 exit', async () => {
    const error = vi.fn();
    const flush = vi.fn(async () => {
      throw new Error('flush failed');
    });
    const exit = vi.fn();
    const controller = new ContainerRestartController({
      logger: { error, flush },
      exit,
    });

    await controller.request({ reason: 'x', source: 'y' });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('忽略巢狀 fields 以避免意外帶入敏感物件', async () => {
    const error = vi.fn();
    const controller = new ContainerRestartController({
      logger: {
        error,
        flush: async () => undefined,
      },
      exit: vi.fn(),
    });

    await controller.request({
      reason: 'x',
      source: 'y',
      fields: {
        channel: 'ok',
        nested: { cookie: 'secret' },
      },
    });

    expect(error).toHaveBeenCalledWith(LOG_EVENTS.CONTAINER_RESTART_REQUESTED, {
      reason: 'x',
      source: 'y',
      channel: 'ok',
    });
  });
});
