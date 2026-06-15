import { describe, expect, it, vi } from 'vitest';

import {
  DefaultSessionManager,
  type ChannelSession,
  type ChannelSessionFactory,
  type SessionManagerLogger,
} from '../../src/sessions/SessionManager.js';

interface TestSession extends ChannelSession {
  readonly secret: string;
}

function createSession(
  channel: string,
  options: {
    readonly onStart?: () => Promise<void>;
    readonly onStop?: (reason: string) => Promise<void>;
    readonly screenshot?: Buffer;
  } = {},
): TestSession {
  return {
    channel,
    secret: `session-secret-${channel}`,
    start: vi.fn(options.onStart ?? (async () => undefined)),
    stop: vi.fn(options.onStop ?? (async () => undefined)),
    checkHealth: vi.fn(async () => ({ healthy: true, reason: 'live' })),
    tickRewardClaim: vi.fn(async () => ({
      status: 'not_found',
      channel,
      checkedAt: '2026-06-14T12:00:00.000Z',
    })),
    captureScreenshot: vi.fn(async () =>
      options.screenshot ?? Buffer.from(`screenshot:${channel}`)),
  };
}

function createFactory(
  builder: (
    channel: string,
    creationIndex: number,
  ) => ChannelSession | Promise<ChannelSession> = (channel) =>
    createSession(channel),
): ChannelSessionFactory & {
  readonly create: ReturnType<typeof vi.fn>;
} {
  let creationIndex = 0;

  return {
    create: vi.fn(
      async (channel: string): Promise<ChannelSession> => {
        const result = await builder(channel, creationIndex);
        creationIndex += 1;
        return result;
      },
    ),
  };
}

function createLogger(): SessionManagerLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function createGate(): {
  readonly promise: Promise<void>;
  readonly release: () => void;
} {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

describe('DefaultSessionManager', () => {
  it('依輸入順序新增 session 並回報 active channels', async () => {
    const events: string[] = [];
    const sessions = new Map<string, TestSession>();
    const factory = createFactory((channel) => {
      const session = createSession(channel, {
        onStart: async () => {
          events.push(`start:${channel}`);
        },
      });
      sessions.set(channel, session);
      return session;
    });
    const manager = new DefaultSessionManager(factory);

    await manager.reconcile(['first', 'second']);

    expect(events).toEqual(['start:first', 'start:second']);
    expect(manager.getActiveChannels()).toEqual(['first', 'second']);
    expect(sessions.get('first')?.start).toHaveBeenCalledOnce();
    expect(sessions.get('second')?.start).toHaveBeenCalledOnce();
  });

  it('先依 registry 順序移除，再依 activeChannels 順序新增', async () => {
    const events: string[] = [];
    const factory = createFactory((channel) =>
      createSession(channel, {
        onStart: async () => {
          events.push(`start:${channel}`);
        },
        onStop: async (reason) => {
          events.push(`stop:${channel}:${reason}`);
        },
      }),
    );
    const manager = new DefaultSessionManager(factory);
    await manager.reconcile(['first', 'second']);
    events.length = 0;

    await manager.reconcile(['second', 'third']);

    expect(events).toEqual(['stop:first:inactive', 'start:third']);
    expect(manager.getActiveChannels()).toEqual(['second', 'third']);
  });

  it('保持既有 session、不重建，並依最新輸入順序回報', async () => {
    const factory = createFactory();
    const manager = new DefaultSessionManager(factory);
    await manager.reconcile(['first', 'second']);

    await manager.reconcile(['second', 'first', 'first']);

    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(manager.getActiveChannels()).toEqual(['second', 'first']);
  });

  it('可擷取預設或指定中的 active session 截圖', async () => {
    const manager = new DefaultSessionManager(createFactory());
    await manager.reconcile(['first', 'second']);

    await expect(manager.captureScreenshot()).resolves.toEqual({
      channel: 'first',
      image: Buffer.from('screenshot:first'),
    });
    await expect(manager.captureScreenshot('SECOND')).resolves.toEqual({
      channel: 'second',
      image: Buffer.from('screenshot:second'),
    });
    await expect(manager.captureScreenshot('missing')).resolves.toBeUndefined();
  });

  it('start failure 不留 registry，且不影響其他頻道啟動', async () => {
    const failed = createSession('failed', {
      onStart: async () => {
        throw new Error('start failed');
      },
    });
    const healthy = createSession('healthy');
    const factory = createFactory((channel) =>
      channel === 'failed' ? failed : healthy,
    );
    const logger = createLogger();
    const manager = new DefaultSessionManager(factory, { logger });

    await manager.reconcile(['failed', 'healthy']);

    expect(manager.getActiveChannels()).toEqual(['healthy']);
    expect(failed.stop).toHaveBeenCalledWith('start_failed');
    expect(healthy.start).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'session_start_failed',
      expect.objectContaining({ channel: 'failed' }),
    );
  });

  it('factory failure 不影響後續頻道，下一輪可重試', async () => {
    let failedOnce = false;
    const factory = createFactory((channel) => {
      if (channel === 'first' && !failedOnce) {
        failedOnce = true;
        throw new Error('factory failed');
      }

      return createSession(channel);
    });
    const manager = new DefaultSessionManager(factory);

    await manager.reconcile(['first', 'second']);
    expect(manager.getActiveChannels()).toEqual(['second']);

    await manager.reconcile(['first', 'second']);
    expect(manager.getActiveChannels()).toEqual(['first', 'second']);
    expect(factory.create).toHaveBeenCalledTimes(3);
  });

  it('stop failure 仍移除舊 session 並繼續新增', async () => {
    const failedStop = createSession('first', {
      onStop: async () => {
        throw new Error('stop failed');
      },
    });
    const healthy = createSession('second');
    const factory = createFactory((channel) =>
      channel === 'first' ? failedStop : healthy,
    );
    const logger = createLogger();
    const manager = new DefaultSessionManager(factory, { logger });
    await manager.reconcile(['first']);

    await manager.reconcile(['second']);

    expect(manager.getActiveChannels()).toEqual(['second']);
    expect(healthy.start).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'session_stop_failed',
      expect.objectContaining({
        channel: 'first',
        reason: 'inactive',
      }),
    );
  });

  it('stopAll 隔離 stop failure、清空 registry 且可重複呼叫', async () => {
    const first = createSession('first', {
      onStop: async () => {
        throw new Error('stop failed');
      },
    });
    const second = createSession('second');
    const factory = createFactory((channel) =>
      channel === 'first' ? first : second,
    );
    const manager = new DefaultSessionManager(factory);
    await manager.reconcile(['first', 'second']);

    await Promise.all([
      manager.stopAll('shutdown'),
      manager.stopAll('duplicate_shutdown'),
    ]);

    expect(manager.getActiveChannels()).toEqual([]);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(first.stop).toHaveBeenCalledWith('shutdown');
    expect(second.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledWith('shutdown');
  });

  it('invalidate 移除並停止 session，重複呼叫無副作用且可由 reconcile 重建', async () => {
    const created: TestSession[] = [];
    const factory = createFactory((channel) => {
      const session = createSession(channel);
      created.push(session);
      return session;
    });
    const manager = new DefaultSessionManager(factory);
    await manager.reconcile(['channel']);

    await manager.invalidate('channel', 'page_crashed');
    await manager.invalidate('channel', 'duplicate_crash');

    expect(manager.getActiveChannels()).toEqual([]);
    expect(created[0]?.stop).toHaveBeenCalledOnce();
    expect(created[0]?.stop).toHaveBeenCalledWith('page_crashed');

    await manager.reconcile(['channel']);

    expect(manager.getActiveChannels()).toEqual(['channel']);
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(created[1]?.start).toHaveBeenCalledOnce();
  });

  it('stop failure 時 invalidate 仍移除，下一輪可重建', async () => {
    const factory = createFactory((channel, creationIndex) =>
      createSession(channel, {
        onStop:
          creationIndex === 0
            ? async () => {
                throw new Error('stop failed');
              }
            : undefined,
      }),
    );
    const manager = new DefaultSessionManager(factory);
    await manager.reconcile(['channel']);

    await manager.invalidate('channel', 'browser_disconnected');
    await manager.reconcile(['channel']);

    expect(manager.getActiveChannels()).toEqual(['channel']);
    expect(factory.create).toHaveBeenCalledTimes(2);
  });

  it('併發 reconcile 依呼叫順序序列化且不重複建立同頻道', async () => {
    const startEntered = createGate();
    const allowStart = createGate();
    const factory = createFactory((channel) =>
      createSession(channel, {
        onStart:
          channel === 'first'
            ? async () => {
                startEntered.release();
                await allowStart.promise;
              }
            : undefined,
      }),
    );
    const manager = new DefaultSessionManager(factory);

    const firstReconcile = manager.reconcile(['first']);
    await startEntered.promise;
    const secondReconcile = manager.reconcile(['first', 'second']);

    expect(factory.create).toHaveBeenCalledTimes(1);
    allowStart.release();
    await Promise.all([firstReconcile, secondReconcile]);

    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(factory.create).toHaveBeenNthCalledWith(1, 'first');
    expect(factory.create).toHaveBeenNthCalledWith(2, 'second');
    expect(manager.getActiveChannels()).toEqual(['first', 'second']);
  });

  it('stopAll 會等待先提交的 reconcile 完成後再清空', async () => {
    const startEntered = createGate();
    const allowStart = createGate();
    const session = createSession('channel', {
      onStart: async () => {
        startEntered.release();
        await allowStart.promise;
      },
    });
    const manager = new DefaultSessionManager(
      createFactory(() => session),
    );

    const reconcile = manager.reconcile(['channel']);
    await startEntered.promise;
    const stopAll = manager.stopAll('shutdown');
    allowStart.release();
    await Promise.all([reconcile, stopAll]);

    expect(session.stop).toHaveBeenCalledWith('shutdown');
    expect(manager.getActiveChannels()).toEqual([]);
  });

  it('invalidate 會等待先提交的 reconcile 完成後移除該 session', async () => {
    const startEntered = createGate();
    const allowStart = createGate();
    const session = createSession('channel', {
      onStart: async () => {
        startEntered.release();
        await allowStart.promise;
      },
    });
    const manager = new DefaultSessionManager(
      createFactory(() => session),
    );

    const reconcile = manager.reconcile(['channel']);
    await startEntered.promise;
    const invalidate = manager.invalidate('channel', 'page_crashed');
    allowStart.release();
    await Promise.all([reconcile, invalidate]);

    expect(session.stop).toHaveBeenCalledWith('page_crashed');
    expect(manager.getActiveChannels()).toEqual([]);
  });

  it('輸入只對完全相同字串去重，大小寫不同視為不同頻道', async () => {
    const factory = createFactory();
    const manager = new DefaultSessionManager(factory);

    await manager.reconcile([
      'Channel',
      'Channel',
      'channel',
      'CHANNEL',
      'channel',
    ]);

    expect(manager.getActiveChannels()).toEqual([
      'Channel',
      'channel',
      'CHANNEL',
    ]);
    expect(factory.create).toHaveBeenCalledTimes(3);
  });

  it('失敗日誌遮罩敏感錯誤內容且不傳 session object', async () => {
    const logger = createLogger();
    const session = createSession('channel', {
      onStart: async () => {
        throw new Error('access_token=top-secret-value');
      },
    });
    const manager = new DefaultSessionManager(
      createFactory(() => session),
      { logger },
    );

    await manager.reconcile(['channel']);

    const errorCall = vi.mocked(logger.error).mock.calls[0];
    expect(errorCall).toBeDefined();
    expect(JSON.stringify(errorCall)).not.toContain('top-secret-value');
    expect(errorCall?.[1]).not.toHaveProperty('session');
    expect(errorCall?.[1]).toEqual({
      channel: 'channel',
      error: 'access_token=[REDACTED]',
    });
  });
});
