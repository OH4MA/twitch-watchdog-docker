import { describe, expect, it, vi } from 'vitest';

import type { RuntimeConfigManager } from '../../src/config/index.js';
import {
  DefaultDiscordBot,
  type DiscordApi,
  type DiscordGatewayEvent,
  type DiscordGatewaySocket,
} from '../../src/discord/index.js';
import type { Logger } from '../../src/logging/index.js';
import type { WatchdogScheduler } from '../../src/scheduler/index.js';
import type { SessionManager } from '../../src/sessions/index.js';
import { createTestConfig } from '../helpers/test-config.js';

describe('DefaultDiscordBot', () => {
  it('registers commands, identifies to the gateway, and handles allowed slash commands', async () => {
    const harness = createHarness();

    await harness.bot.start();
    harness.socket.emit('open');
    harness.socket.emit('message', {
      op: 10,
      d: { heartbeat_interval: 45_000 },
    });
    await harness.socket.emit('message', interaction('1', 'status'));
    await harness.socket.emit('message', interaction('2', 'check'));
    await harness.socket.emit('message', interaction('3', 'pause'));
    await harness.socket.emit('message', interaction('4', 'resume'));
    await harness.socket.emit(
      'message',
      interaction('5', 'refresh_now', 'second'),
    );
    await harness.socket.emit(
      'message',
      interaction('6', 'screenshot', 'second'),
    );

    expect(harness.api.registerCommands).toHaveBeenCalledWith(
      'app-id',
      'guild-id',
      expect.arrayContaining([
        expect.objectContaining({ name: 'status' }),
        expect.objectContaining({ name: 'screenshot' }),
      ]),
    );
    expect(harness.gatewayFactory).toHaveBeenCalledWith(
      'wss://gateway.discord.gg?v=10&encoding=json',
    );
    expect(JSON.parse(harness.socket.sent[0] ?? '{}')).toMatchObject({
      op: 2,
      d: {
        token: 'discord-token',
        intents: 0,
      },
    });
    expect(JSON.parse(harness.socket.sent[1] ?? '{}')).toEqual({
      op: 1,
      d: null,
    });
    await vi.waitFor(() => {
      expect(harness.scheduler.runOnce).toHaveBeenCalledOnce();
      expect(harness.scheduler.stop).toHaveBeenCalledOnce();
      expect(harness.scheduler.start).toHaveBeenCalledOnce();
      expect(harness.sessionManager.refreshPages).toHaveBeenCalledWith(
        'second',
      );
      expect(harness.sessionManager.captureScreenshot).toHaveBeenCalledWith(
        'second',
      );
      expect(harness.api.sendInteractionPhoto).toHaveBeenCalledWith(
        'app-id',
        'token-6',
        Buffer.from('screenshot:second'),
        'second.png',
        'second 目前瀏覽器畫面',
      );
    });
    const replies = harness.api.sendInteractionResponse.mock.calls.map(
      ([, , content]) => content,
    );
    expect(replies.some((text) => text.includes('自動檢查'))).toBe(true);
    expect(replies).toContain('自動檢查已暫停。');
    expect(replies).toContain('自動檢查已恢復。');
    const editedReplies = harness.api.editInteractionResponse.mock.calls.map(
      ([, , content]) => content,
    );
    expect(editedReplies).toContain('已完成一次狀態檢查。');
    expect(editedReplies.some((text) => text.includes('手動重整結果'))).toBe(
      true,
    );
    expect(harness.api.deferInteractionResponse).toHaveBeenCalledWith(
      'interaction-2',
      'token-2',
    );

    await harness.bot.stop('test');
    expect(harness.socket.closed).toEqual({ code: 1000, reason: 'test' });
  });

  it('rejects interactions from unauthorized channels', async () => {
    const harness = createHarness();

    await harness.bot.start();
    await harness.socket.emit(
      'message',
      interaction('9', 'pause', undefined, '999999999999999999'),
    );

    expect(harness.logger.warn).toHaveBeenCalledWith(
      'discord_unauthorized_channel',
      { channelId: '999999999999999999' },
    );
    expect(harness.scheduler.stop).not.toHaveBeenCalled();
    expect(harness.api.sendInteractionResponse).toHaveBeenCalledWith(
      'interaction-9',
      'token-9',
      '這個 Discord channel 未被允許使用。',
    );
  });

  it('allows direct message interactions from configured Discord users', async () => {
    const harness = createHarness({
      allowDirectMessages: true,
      allowedUserIds: ['333333333333333333'],
    });

    await harness.bot.start();
    await harness.socket.emit(
      'message',
      interaction('10', 'status', undefined, undefined, {
        guildId: undefined,
        userId: '333333333333333333',
      }),
    );

    expect(harness.api.sendInteractionResponse).toHaveBeenCalledWith(
      'interaction-10',
      'token-10',
      expect.stringContaining('自動檢查'),
    );
  });

  it('rejects direct message interactions from unauthorized Discord users', async () => {
    const harness = createHarness({
      allowDirectMessages: true,
      allowedUserIds: ['333333333333333333'],
    });

    await harness.bot.start();
    await harness.socket.emit(
      'message',
      interaction('11', 'pause', undefined, undefined, {
        guildId: undefined,
        userId: '444444444444444444',
      }),
    );

    expect(harness.logger.warn).toHaveBeenCalledWith(
      'discord_unauthorized_dm_user',
      { userId: '444444444444444444' },
    );
    expect(harness.scheduler.stop).not.toHaveBeenCalled();
    expect(harness.api.sendInteractionResponse).toHaveBeenCalledWith(
      'interaction-11',
      'token-11',
      '這個 Discord 使用者未被允許透過私訊控制服務。',
    );
  });

  it('broadcasts service notifications to allowed channels', async () => {
    const harness = createHarness();

    await harness.bot.start();
    await harness.bot.notifyStreamStatus({
      channel: 'first',
      isLive: true,
    });
    await harness.bot.notifyReward({
      channel: 'first',
      status: 'claimed',
    });
    await harness.bot.notifyPageRefresh({ channel: 'first' });

    const messages = harness.api.sendMessage.mock.calls.map(
      ([channelId, content]) => `${channelId}:${content}`,
    );
    expect(messages).toContain(
      '111111111111111111:🔴 first 已開台',
    );
    expect(messages).toContain(
      '111111111111111111:🎁 first 已領取忠誠點數',
    );
    expect(messages).toContain(
      '111111111111111111:🔄 first 正在重整 Twitch 播放器',
    );
  });
});

interface HarnessOptions {
  readonly allowDirectMessages?: boolean;
  readonly allowedUserIds?: readonly string[];
}

function createHarness(options: HarnessOptions = {}) {
  const socket = new MockGatewaySocket();
  const gatewayFactory = vi.fn(() => socket);
  const api: DiscordApi & MockedDiscordApi = {
    getGatewayBot: vi.fn(async () => ({ url: 'wss://gateway.discord.gg' })),
    registerCommands: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    sendInteractionResponse: vi.fn(async () => undefined),
    deferInteractionResponse: vi.fn(async () => undefined),
    editInteractionResponse: vi.fn(async () => undefined),
    sendInteractionPhoto: vi.fn(async () => undefined),
  };
  const scheduler: WatchdogScheduler & MockedScheduler = {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    runOnce: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => ({
      running: true,
      checkInFlight: false,
      channels: [
        { channel: 'first', isLive: true },
        { channel: 'second', isLive: false },
      ],
    })),
    updateConfig: vi.fn(async () => undefined),
  };
  const sessionManager: SessionManager & MockedSessionManager = {
    reconcile: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
    getActiveChannels: vi.fn(() => ['first', 'second']),
    getRefreshStatuses: vi.fn(() => [{
      channel: 'first',
      enabled: true,
      secondsUntilRefresh: 4,
      nextRefreshAt: '2026-06-27T00:00:00.000Z',
    }]),
    refreshPages: vi.fn(async () => [{
      channel: 'second',
      status: 'refreshed',
    }]),
    captureScreenshot: vi.fn(async (channel = 'first') => ({
      channel,
      image: Buffer.from(`screenshot:${channel}`),
    })),
  };
  const runtimeConfigManager: RuntimeConfigManager = {
    getConfig: vi.fn(() => ({
      channels: ['first', 'second'],
      maxConcurrentStreams: 2,
    })),
    setChannels: vi.fn(async (channels) => ({
      channels,
      maxConcurrentStreams: 2,
    })),
    setMaxConcurrentStreams: vi.fn(async (maxConcurrentStreams) => ({
      channels: ['first', 'second'],
      maxConcurrentStreams,
    })),
  };
  const logger: Logger & MockedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
  };
  const bot = new DefaultDiscordBot({
    config: createTestConfig({
      discord: {
        enabled: true,
        botToken: 'discord-token',
        applicationId: 'app-id',
        guildId: 'guild-id',
        allowedChannelIds: ['111111111111111111'],
        allowDirectMessages: options.allowDirectMessages ?? false,
        allowedUserIds: options.allowedUserIds ?? [],
      },
    }),
    api,
    scheduler,
    sessionManager,
    runtimeConfigManager,
    logger,
    gatewayFactory,
    timer: {
      setInterval: vi.fn(() => 'interval'),
      clearInterval: vi.fn(),
    },
  });

  return {
    bot,
    socket,
    gatewayFactory,
    api,
    scheduler,
    sessionManager,
    logger,
  };
}

function interaction(
  id: string,
  name: string,
  value?: string,
  channelId = '111111111111111111',
  options: {
    readonly guildId?: string;
    readonly userId?: string;
  } = { guildId: 'guild-id' },
): object {
  return {
    op: 0,
    t: 'INTERACTION_CREATE',
    s: Number(id),
    d: {
      id: `interaction-${id}`,
      token: `token-${id}`,
      ...(channelId === undefined ? {} : { channel_id: channelId }),
      ...(options.guildId === undefined ? {} : { guild_id: options.guildId }),
      ...(options.userId === undefined
        ? {}
        : { user: { id: options.userId } }),
      type: 2,
      data: {
        name,
        options: value === undefined
          ? []
          : [{ name: 'channel', value }],
      },
    },
  };
}

class MockGatewaySocket implements DiscordGatewaySocket {
  public readonly sent: string[] = [];
  public closed: { code?: number; reason?: string } | undefined;
  private readonly listeners = new Map<
    string,
    ((event: DiscordGatewayEvent) => void | Promise<void>)[]
  >();

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  public addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: DiscordGatewayEvent) => void | Promise<void>,
  ): void {
    this.listeners.set(type, [
      ...(this.listeners.get(type) ?? []),
      listener,
    ]);
  }

  public async emit(type: string, payload?: object): Promise<void> {
    await Promise.all(
      (this.listeners.get(type) ?? []).map((listener) =>
        listener({
          data: type === 'message' ? JSON.stringify(payload) : undefined,
        }),
      ),
    );
  }
}

type MockedDiscordApi = {
  readonly [K in keyof DiscordApi]: ReturnType<typeof vi.fn>;
};

type MockedScheduler = {
  readonly [K in keyof WatchdogScheduler]: ReturnType<typeof vi.fn>;
};

type MockedSessionManager = {
  readonly [K in keyof SessionManager]: ReturnType<typeof vi.fn>;
};

type MockedLogger = {
  readonly [K in keyof Logger]: ReturnType<typeof vi.fn>;
};
