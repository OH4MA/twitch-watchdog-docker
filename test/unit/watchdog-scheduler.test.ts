import { describe, expect, it, vi } from 'vitest';

import {
  LOG_EVENTS,
  type Logger,
} from '../../src/logging/index.js';
import {
  DefaultWatchdogScheduler,
  type SchedulerTimer,
} from '../../src/scheduler/WatchdogScheduler.js';
import type { SessionManager } from '../../src/sessions/index.js';
import {
  selectActiveChannels,
  type StreamSelector,
} from '../../src/scheduler/StreamSelector.js';
import {
  TwitchApiAuthError,
  TwitchApiRateLimitError,
  TwitchApiTemporaryError,
  type ChannelLiveStatus,
  type LiveStatusProvider,
} from '../../src/twitch/index.js';

const CHECKED_AT = '2026-06-14T12:00:00.000Z';

describe('DefaultWatchdogScheduler', () => {
  it('第一輪 live 輸出 online，後續不變不重複輸出，offline 時輸出轉換', async () => {
    const harness = createHarness({
      channels: ['first', 'second'],
      maxConcurrentStreams: 2,
    });
    harness.getLiveStatuses
      .mockResolvedValueOnce([
        status('first', true),
        status('second', false),
      ])
      .mockResolvedValueOnce([
        status('first', true),
        status('second', false),
      ])
      .mockResolvedValueOnce([
        status('first', false),
        status('second', true),
      ]);

    await harness.scheduler.runOnce();
    await harness.scheduler.runOnce();
    await harness.scheduler.runOnce();

    expect(harness.reconcile.mock.calls).toEqual([
      [['first']],
      [['first']],
      [['second']],
    ]);
    expect(harness.logger.info.mock.calls).toEqual([
      [
        LOG_EVENTS.STREAM_ONLINE,
        { channel: 'first' },
      ],
      [
        LOG_EVENTS.STREAM_OFFLINE,
        { channel: 'first' },
      ],
      [
        LOG_EVENTS.STREAM_ONLINE,
        { channel: 'second' },
      ],
    ]);
    expect(harness.onStreamStatusChanged.mock.calls).toEqual([
      [{ channel: 'first', isLive: true }],
      [{ channel: 'first', isLive: false }],
      [{ channel: 'second', isLive: true }],
    ]);
    expect(harness.scheduler.getSnapshot()).toEqual({
      running: false,
      checkInFlight: false,
      lastCheckedAt: CHECKED_AT,
      channels: [
        { channel: 'first', isLive: false },
        { channel: 'second', isLive: true },
      ],
    });
  });

  it('第一輪全部 offline 不輸出狀態噪音但仍 reconcile 空集合', async () => {
    const harness = createHarness({ channels: ['first', 'second'] });
    harness.getLiveStatuses.mockResolvedValue([
      status('first', false),
      status('second', false),
    ]);

    await harness.scheduler.runOnce();

    expect(harness.logger.info).not.toHaveBeenCalled();
    expect(harness.reconcile).toHaveBeenCalledOnce();
    expect(harness.reconcile).toHaveBeenCalledWith([]);
  });

  it('高優先序頻道上線時由 selector 與 reconcile 替換低優先序頻道', async () => {
    const harness = createHarness({
      channels: ['high', 'low'],
      maxConcurrentStreams: 1,
    });
    harness.getLiveStatuses
      .mockResolvedValueOnce([
        status('low', true),
        status('high', false),
      ])
      .mockResolvedValueOnce([
        status('low', true),
        status('high', true),
      ]);

    await harness.scheduler.runOnce();
    await harness.scheduler.runOnce();

    expect(harness.reconcile.mock.calls).toEqual([
      [['low']],
      [['high']],
    ]);
    expect(harness.selectActiveChannels).toHaveBeenLastCalledWith({
      configuredChannels: ['high', 'low'],
      liveStatuses: [
        status('low', true),
        status('high', true),
      ],
      maxConcurrentStreams: 1,
    });
  });

  it.each([
    ['auth', new TwitchApiAuthError(401)],
    [
      'rate-limit',
      new TwitchApiRateLimitError(
        new Date('2026-06-14T12:01:00.000Z'),
        60_000,
      ),
    ],
    [
      'temporary',
      new TwitchApiTemporaryError('network', undefined),
    ],
  ])('%s API 失敗時保留既有 session，不 reconcile 空集合', async (_kind, error) => {
    const harness = createHarness({ channels: ['live'] });
    harness.getLiveStatuses
      .mockResolvedValueOnce([status('live', true)])
      .mockRejectedValueOnce(error);

    await harness.scheduler.runOnce();
    await harness.scheduler.runOnce();

    expect(harness.reconcile).toHaveBeenCalledOnce();
    expect(harness.reconcile).toHaveBeenCalledWith(['live']);

    if (error instanceof TwitchApiAuthError) {
      expect(harness.logger.error).toHaveBeenCalledWith(
        LOG_EVENTS.TWITCH_API_AUTH_FAILED,
        { statusCode: error.statusCode },
      );
    } else if (error instanceof TwitchApiRateLimitError) {
      expect(harness.logger.warn).toHaveBeenCalledWith(
        'twitch_api_rate_limited',
        {
          retryAt: error.retryAt.toISOString(),
          retryAfterMs: error.retryAfterMs,
        },
      );
    } else {
      expect(harness.logger.warn).toHaveBeenCalledWith(
        'twitch_api_temporary_error',
        { reason: error.reason },
      );
    }
  });

  it.each([
    ['auth', new TwitchApiAuthError(403)],
    [
      'temporary',
      new TwitchApiTemporaryError('server', 503),
    ],
  ])('%s 失敗後於下一個正常 interval 重試', async (_kind, error) => {
    const timer = createTimer();
    const harness = createHarness({
      channels: ['live'],
      timer: timer.value,
    });
    harness.getLiveStatuses
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce([status('live', true)]);

    harness.scheduler.start();
    await vi.waitFor(() => {
      expect(harness.getLiveStatuses).toHaveBeenCalledOnce();
      expect(loggerCallCount(harness.logger)).toBeGreaterThan(0);
    });

    timer.fire();

    await vi.waitFor(() => {
      expect(harness.getLiveStatuses).toHaveBeenCalledTimes(2);
      expect(harness.reconcile).toHaveBeenCalledWith(['live']);
    });
    await harness.scheduler.stop();
  });

  it('rate-limit 視窗結束前 interval tick 會略過，到 retryAt 才重新請求', async () => {
    const timer = createTimer();
    let now = new Date('2026-06-14T12:00:00.000Z');
    const retryAt = new Date('2026-06-14T12:01:00.000Z');
    const harness = createHarness({
      channels: ['live'],
      timer: timer.value,
      now: () => now,
    });
    harness.getLiveStatuses
      .mockRejectedValueOnce(
        new TwitchApiRateLimitError(retryAt, 60_000),
      )
      .mockResolvedValueOnce([status('live', true)]);

    harness.scheduler.start();
    await vi.waitFor(() => {
      expect(harness.logger.warn).toHaveBeenCalledWith(
        'twitch_api_rate_limited',
        {
          retryAt: retryAt.toISOString(),
          retryAfterMs: 60_000,
        },
      );
    });

    now = new Date('2026-06-14T12:00:30.000Z');
    timer.fire();

    expect(harness.getLiveStatuses).toHaveBeenCalledOnce();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      'scheduler_tick_skipped',
      {
        reason: 'rate_limited',
        retryAt: retryAt.toISOString(),
      },
    );

    now = retryAt;
    timer.fire();

    await vi.waitFor(() => {
      expect(harness.getLiveStatuses).toHaveBeenCalledTimes(2);
      expect(harness.reconcile).toHaveBeenCalledWith(['live']);
    });
    await harness.scheduler.stop();
  });

  it('runOnce 不重入，略過的呼叫立即 resolve', async () => {
    const request = deferred<ChannelLiveStatus[]>();
    const harness = createHarness({ channels: ['live'] });
    harness.getLiveStatuses.mockReturnValue(request.promise);

    const firstRun = harness.scheduler.runOnce();
    let firstRunSettled = false;
    void firstRun.then(() => {
      firstRunSettled = true;
    });

    await expect(harness.scheduler.runOnce()).resolves.toBeUndefined();

    expect(firstRunSettled).toBe(false);
    expect(harness.getLiveStatuses).toHaveBeenCalledOnce();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      'scheduler_tick_skipped',
      { reason: 'in_flight' },
    );

    request.resolve([status('live', true)]);
    await firstRun;
  });

  it('start 立即執行首輪並依設定建立 interval，重複 start 不新增 timer', async () => {
    const timer = createTimer();
    const harness = createHarness({
      channels: ['live'],
      checkIntervalSeconds: 45,
      timer: timer.value,
    });
    harness.getLiveStatuses.mockResolvedValue([status('live', true)]);

    harness.scheduler.start();
    harness.scheduler.start();

    expect(harness.getLiveStatuses).toHaveBeenCalledOnce();
    expect(timer.setInterval).toHaveBeenCalledOnce();
    expect(timer.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      45_000,
    );

    await vi.waitFor(() => {
      expect(harness.reconcile).toHaveBeenCalledWith(['live']);
    });
    await harness.scheduler.stop();
  });

  it('stop 清除 timer 並等待執行中的首輪完成，停止後 timer callback 無效', async () => {
    const timer = createTimer();
    const request = deferred<ChannelLiveStatus[]>();
    const harness = createHarness({
      channels: ['live'],
      timer: timer.value,
    });
    harness.getLiveStatuses.mockReturnValue(request.promise);

    harness.scheduler.start();
    let stopSettled = false;
    const stopPromise = harness.scheduler.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    expect(timer.clearInterval).toHaveBeenCalledOnce();
    expect(timer.clearInterval).toHaveBeenCalledWith(timer.handle);
    expect(stopSettled).toBe(false);

    request.resolve([status('live', true)]);
    await stopPromise;
    await harness.scheduler.stop();
    timer.fire();

    expect(stopSettled).toBe(true);
    expect(harness.getLiveStatuses).toHaveBeenCalledOnce();
    expect(timer.clearInterval).toHaveBeenCalledOnce();
  });

  it('API 回傳缺少 configured channel 時保留 session 與上一輪狀態', async () => {
    const harness = createHarness({
      channels: ['first', 'second'],
      maxConcurrentStreams: 2,
    });
    harness.getLiveStatuses
      .mockResolvedValueOnce([
        status('first', true),
        status('second', true),
      ])
      .mockResolvedValueOnce([status('first', false)])
      .mockResolvedValueOnce([
        status('first', true),
        status('second', true),
      ]);

    await harness.scheduler.runOnce();
    await harness.scheduler.runOnce();
    await harness.scheduler.runOnce();

    expect(harness.reconcile).toHaveBeenCalledTimes(2);
    expect(harness.reconcile).toHaveBeenNthCalledWith(1, [
      'first',
      'second',
    ]);
    expect(harness.reconcile).toHaveBeenNthCalledWith(2, [
      'first',
      'second',
    ]);
    expect(harness.logger.info).not.toHaveBeenCalledWith(
      LOG_EVENTS.STREAM_OFFLINE,
      expect.objectContaining({ channel: 'first' }),
    );
  });

  it('更新 runtime config 後立即套用新頻道與同時觀看上限', async () => {
    const harness = createHarness({
      channels: ['first', 'second'],
      maxConcurrentStreams: 2,
    });
    harness.getLiveStatuses
      .mockResolvedValueOnce([
        status('first', true),
        status('second', true),
      ])
      .mockResolvedValueOnce([
        status('second', true),
        status('third', false),
      ]);

    await harness.scheduler.runOnce();
    await harness.scheduler.updateConfig({
      channels: ['second', 'third'],
      maxConcurrentStreams: 1,
    });

    expect(harness.getLiveStatuses).toHaveBeenLastCalledWith([
      'second',
      'third',
    ]);
    expect(harness.reconcile).toHaveBeenNthCalledWith(2, ['second']);
    expect(harness.reconcile).toHaveBeenLastCalledWith(['second']);
    expect(harness.scheduler.getSnapshot().channels).toEqual([
      { channel: 'second', isLive: true },
      { channel: 'third', isLive: false },
    ]);
  });

  it('錯誤日誌不轉送 API 原始錯誤中的 token、Authorization 或 Bearer 值', async () => {
    const secret = 'scheduler-secret-token';
    const harness = createHarness({ channels: ['live'] });
    harness.getLiveStatuses.mockRejectedValue(
      new Error(
        `Authorization: Bearer ${secret}; access_token=${secret}`,
      ),
    );

    await harness.scheduler.runOnce();

    const serializedCalls = JSON.stringify([
      harness.logger.debug.mock.calls,
      harness.logger.info.mock.calls,
      harness.logger.warn.mock.calls,
      harness.logger.error.mock.calls,
    ]);
    expect(serializedCalls).not.toContain(secret);
    expect(serializedCalls).not.toContain('Authorization');
    expect(serializedCalls).not.toContain('Bearer');
    expect(harness.logger.warn).toHaveBeenCalledWith(
      'twitch_api_request_failed',
      { kind: 'unknown' },
    );
    expect(harness.reconcile).not.toHaveBeenCalled();
  });
});

interface HarnessOptions {
  readonly channels?: readonly string[];
  readonly checkIntervalSeconds?: number;
  readonly maxConcurrentStreams?: number;
  readonly timer?: SchedulerTimer;
  readonly now?: () => Date;
  readonly onStreamStatusChanged?: (
    change: { channel: string; isLive: boolean },
  ) => void | Promise<void>;
}

function createHarness(options: HarnessOptions = {}) {
  const getLiveStatuses =
    vi.fn<LiveStatusProvider['getLiveStatuses']>();
  const reconcile = vi
    .fn<SessionManager['reconcile']>()
    .mockResolvedValue(undefined);
  const stopAll = vi
    .fn<SessionManager['stopAll']>()
    .mockResolvedValue(undefined);
  const getActiveChannels = vi
    .fn<SessionManager['getActiveChannels']>()
    .mockReturnValue([]);
  const invalidate = vi
    .fn<SessionManager['invalidate']>()
    .mockResolvedValue(undefined);
  const select = vi.fn<StreamSelector['selectActiveChannels']>(
    (input) => selectActiveChannels(input),
  );
  const logger = createLoggerMock();
  const onStreamStatusChanged = vi.fn(
    options.onStreamStatusChanged ?? (() => undefined),
  );
  const scheduler = new DefaultWatchdogScheduler({
    config: {
      channels: options.channels ?? ['live'],
      checkIntervalSeconds:
        options.checkIntervalSeconds ?? 60,
      maxConcurrentStreams:
        options.maxConcurrentStreams ?? 1,
    },
    liveStatusProvider: { getLiveStatuses },
    streamSelector: { selectActiveChannels: select },
    sessionManager: {
      reconcile,
      stopAll,
      getActiveChannels,
      getRefreshStatuses: vi.fn(() => []),
      invalidate,
      captureScreenshot: vi.fn(async () => undefined),
    },
    logger,
    ...(options.timer === undefined
      ? {}
      : { timer: options.timer }),
    now: options.now ?? (() => new Date(CHECKED_AT)),
    onStreamStatusChanged,
  });

  return {
    getLiveStatuses,
    logger,
    reconcile,
    scheduler,
    selectActiveChannels: select,
    onStreamStatusChanged,
  };
}

function status(
  channel: string,
  isLive: boolean,
): ChannelLiveStatus {
  return {
    channel,
    isLive,
    checkedAt: CHECKED_AT,
  };
}

function createLoggerMock() {
  return {
    debug: vi.fn<Logger['debug']>(),
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
    flush: vi.fn<Logger['flush']>().mockResolvedValue(undefined),
  };
}

function loggerCallCount(logger: ReturnType<typeof createLoggerMock>): number {
  return (
    logger.debug.mock.calls.length +
    logger.info.mock.calls.length +
    logger.warn.mock.calls.length +
    logger.error.mock.calls.length
  );
}

function createTimer() {
  let callback: (() => void) | undefined;
  const handle = { type: 'test-interval' };
  const setIntervalMock = vi.fn<SchedulerTimer['setInterval']>(
    (scheduledCallback) => {
      callback = scheduledCallback;
      return handle;
    },
  );
  const clearIntervalMock =
    vi.fn<SchedulerTimer['clearInterval']>();

  return {
    value: {
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    } satisfies SchedulerTimer,
    handle,
    setInterval: setIntervalMock,
    clearInterval: clearIntervalMock,
    fire(): void {
      callback?.();
    },
  };
}

function deferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => {
    throw new Error('Deferred promise is not initialized');
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}
