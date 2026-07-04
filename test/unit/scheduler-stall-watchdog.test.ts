import { afterEach, describe, expect, it, vi } from 'vitest';

import { SchedulerStallWatchdog } from '../../src/app/SchedulerStallWatchdog.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('SchedulerStallWatchdog', () => {
  it('checkInFlight 持續超過門檻時 flush log 並要求 process exit', async () => {
    vi.useFakeTimers();
    let now = 0;
    let checkInFlight = true;
    const error = vi.fn();
    const flush = vi.fn(async () => undefined);
    const exit = vi.fn();
    const watchdog = new SchedulerStallWatchdog({
      scheduler: {
        getSnapshot: () => ({
          running: true,
          checkInFlight,
          lastCheckedAt: '2026-06-14T00:00:00.000Z',
          channels: [],
        }),
      },
      logger: {
        info: vi.fn(),
        error,
        flush,
      },
      intervalSeconds: 10,
      stallThresholdMs: 30_000,
      now: () => now,
      exit,
    });

    await watchdog.start();
    now = 20_000;
    vi.advanceTimersByTime(10_000);
    expect(exit).not.toHaveBeenCalled();

    now = 30_000;
    vi.advanceTimersByTime(10_000);
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });

    expect(error).toHaveBeenCalledWith('scheduler_stall_detected', {
      inFlightDurationMs: 30_000,
      stallThresholdMs: 30_000,
      running: true,
      lastCheckedAt: '2026-06-14T00:00:00.000Z',
      retryAt: undefined,
    });
    expect(flush).toHaveBeenCalledOnce();

    checkInFlight = false;
    await watchdog.stop();
  });

  it('checkInFlight 解除後會重置卡住計時', async () => {
    vi.useFakeTimers();
    let now = 0;
    let checkInFlight = true;
    const exit = vi.fn();
    const watchdog = new SchedulerStallWatchdog({
      scheduler: {
        getSnapshot: () => ({
          running: true,
          checkInFlight,
          channels: [],
        }),
      },
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      intervalSeconds: 10,
      stallThresholdMs: 30_000,
      now: () => now,
      exit,
    });

    await watchdog.start();
    now = 20_000;
    vi.advanceTimersByTime(10_000);
    checkInFlight = false;
    now = 25_000;
    vi.advanceTimersByTime(10_000);
    checkInFlight = true;
    now = 50_000;
    vi.advanceTimersByTime(10_000);

    expect(exit).not.toHaveBeenCalled();
    await watchdog.stop();
  });

  it('stop 後不再檢查 scheduler 狀態', async () => {
    vi.useFakeTimers();
    let now = 0;
    const getSnapshot = vi.fn(() => ({
      running: true,
      checkInFlight: true,
      channels: [],
    }));
    const exit = vi.fn();
    const watchdog = new SchedulerStallWatchdog({
      scheduler: { getSnapshot },
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      intervalSeconds: 10,
      stallThresholdMs: 30_000,
      now: () => now,
      exit,
    });

    await watchdog.start();
    await watchdog.stop();
    now = 60_000;
    vi.advanceTimersByTime(60_000);

    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});
