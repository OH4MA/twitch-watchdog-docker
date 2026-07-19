import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/logging/index.js';
import type { BotCommandContext } from '../../src/notifications/BotCommandContext.js';
import type { WatchdogScheduler } from '../../src/scheduler/index.js';
import type { SessionManager } from '../../src/sessions/index.js';
import {
  DefaultTelegramBot,
  type TelegramApi,
  type TelegramUpdate,
} from '../../src/telegram/index.js';
import { createTestConfig } from '../helpers/test-config.js';

describe('DefaultTelegramBot', () => {
  it('啟動、處理授權指令並可停止長輪詢', async () => {
    const harness = createHarness([
      update(1, '42', '/status'),
      update(2, '42', '/check'),
      update(3, '42', '/pause'),
      update(4, '42', '/resume'),
      update(5, '42', '/channels'),
      update(6, '42', '/refresh'),
      update(7, '42', '/refresh_now second'),
      update(8, '42', '/screenshot second'),
    ]);

    await harness.bot.start();

    await vi.waitFor(() => {
      expect(harness.scheduler.runOnce).toHaveBeenCalledOnce();
      expect(harness.scheduler.stop).toHaveBeenCalledOnce();
      expect(harness.scheduler.start).toHaveBeenCalledOnce();
    });
    await harness.bot.stop('test');

    const messages = harness.api.sendMessage.mock.calls.map(
      ([, text]) => text,
    );
    expect(messages[0]).toContain('Twitch Watchdog 已啟動');
    expect(harness.api.setMyCommands).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          command: 'status',
          description: '顯示服務與觀看狀態',
        },
        {
          command: 'refresh',
          description: '顯示播放器重整倒數',
        },
      ]),
    );
    expect(harness.api.sendMessage.mock.calls[0]?.[2]).toEqual({
      reply_markup: expect.objectContaining({
        is_persistent: true,
        resize_keyboard: true,
      }),
    });
    expect(messages).toContain('已完成一次狀態檢查。');
    expect(messages).toContain('自動檢查已暫停。');
    expect(messages).toContain('自動檢查已恢復。');
    expect(messages.some((text) => text.includes('正在觀看：first'))).toBe(
      true,
    );
    expect(messages.some((text) => text.includes('1. 🔴 first'))).toBe(
      true,
    );
    expect(messages.some((text) => text.includes('重整倒數'))).toBe(
      true,
    );
    expect(messages.some((text) => text.includes('first：4 分鐘後'))).toBe(
      true,
    );
    expect(messages.some((text) => text.includes('second：已重整'))).toBe(
      true,
    );
    expect(harness.api.sendPhoto).toHaveBeenCalledWith(
      '42',
      Buffer.from('screenshot:second'),
      'second.png',
      'second 目前瀏覽器畫面',
    );
    expect(messages.at(-1)).toContain('Twitch Watchdog 已停止');
    expect(harness.api.getUpdates.mock.calls[0]?.[0]).toBeUndefined();
    expect(harness.api.getUpdates.mock.calls[1]?.[0]).toBe(9);
  });

  it('忽略未授權 chat 且不執行管理指令', async () => {
    const harness = createHarness([update(1, '99', '/pause')]);

    await harness.bot.start();
    await vi.waitFor(() => {
      expect(harness.logger.warn).toHaveBeenCalledWith(
        'telegram_unauthorized_chat',
        { chatId: '99' },
      );
    });
    await harness.bot.stop('test');

    expect(harness.scheduler.stop).not.toHaveBeenCalled();
    expect(
      harness.api.sendMessage.mock.calls.some(([chatId]) => chatId === '99'),
    ).toBe(false);
  });

  it('回覆失敗時不重複執行同一個管理指令', async () => {
    const harness = createHarness([update(10, '42', '/check')]);
    harness.api.sendMessage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('send failed'));

    await harness.bot.start();
    await vi.waitFor(() => {
      expect(harness.logger.warn).toHaveBeenCalledWith(
        'telegram_command_failed',
        { updateId: 10, error: 'send failed' },
      );
    });
    await harness.bot.stop('test');

    expect(harness.scheduler.runOnce).toHaveBeenCalledOnce();
    expect(harness.api.getUpdates.mock.calls[1]?.[0]).toBe(11);
  });

  it('推送開台、離線與領點通知，忽略 not_found', async () => {
    const harness = createHarness([]);

    await harness.bot.notifyStreamStatus({
      channel: 'first',
      isLive: true,
    });
    await harness.bot.notifyStreamStatus({
      channel: 'first',
      isLive: false,
    });
    await harness.bot.notifyReward({
      status: 'claimed',
      channel: 'first',
      claimedAt: '2026-06-14T00:00:00.000Z',
    });
    await harness.bot.notifyReward({
      status: 'not_found',
      channel: 'first',
      checkedAt: '2026-06-14T00:00:00.000Z',
    });
    expect(harness.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(harness.api.sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '🔴 first 已開台',
      '⚫ first 已離線',
      '🎁 first 已領取忠誠點數',
    ]);
  });

  it('推送 page crash、browser restart 與 container restart 通知', async () => {
    const harness = createHarness([]);

    await harness.bot.notifyPageCrash('first');
    await harness.bot.notifyBrowserRestart({ mode: 'automatic' });
    await harness.bot.notifyBrowserRestart({ mode: 'manual' });
    await harness.bot.notifyContainerRestart({
      reason: 'browser_crash_loop',
      source: 'browser_manager',
      detailReason: 'channel_page_crash_loop',
      channel: 'first',
    });

    expect(harness.api.sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '💥 first 觀看頁面崩潰',
      '♻️ Firefox 瀏覽器已重啟（自動恢復）',
      '♻️ Firefox 瀏覽器已重啟（完整回收）',
      [
        '🚨 容器即將重啟',
        '原因：browser_crash_loop（channel_page_crash_loop）',
        '來源：browser_manager',
        '頻道：first',
      ].join('\n'),
    ]);
  });

  it('尚未啟動時 stop 不傳送誤導通知', async () => {
    const harness = createHarness([]);

    await harness.bot.stop('startup_failed:browser');

    expect(harness.api.sendMessage).not.toHaveBeenCalled();
    expect(harness.api.getUpdates).not.toHaveBeenCalled();
  });

  it('沒有 active session 時截圖指令回覆提示', async () => {
    const harness = createHarness([update(1, '42', '/screenshot')], []);

    await harness.bot.start();
    await vi.waitFor(() => {
      expect(harness.api.sendMessage).toHaveBeenCalledWith(
        '42',
        '目前沒有正在觀看的頻道可供截圖。',
      );
    });
    await harness.bot.stop('test');

    expect(harness.api.sendPhoto).not.toHaveBeenCalled();
  });

  it('忠誠點數指令可查詢全部或指定頻道', async () => {
    const harness = createHarness([
      update(1, '42', '/points'),
      update(2, '42', '/points SECOND'),
    ]);
    vi.mocked(harness.sessionManager.getChannelPoints)
      .mockResolvedValueOnce([
        {
          channel: 'first',
          status: 'available',
          balance: 1_234_567,
          displayValue: '1.23M',
        },
        {
          channel: 'second',
          status: 'unavailable',
          reason: 'parse_failed',
        },
      ])
      .mockResolvedValueOnce([{
        channel: 'second',
        status: 'available',
        balance: 9_876,
        displayValue: '9.8K',
      }]);

    await harness.bot.start();
    await vi.waitFor(() => {
      expect(harness.sessionManager.getChannelPoints).toHaveBeenCalledTimes(2);
    });
    await harness.bot.stop('test');

    expect(harness.sessionManager.getChannelPoints).toHaveBeenNthCalledWith(
      1,
      undefined,
    );
    expect(harness.sessionManager.getChannelPoints).toHaveBeenNthCalledWith(
      2,
      'SECOND',
    );
    expect(harness.api.sendMessage.mock.calls.map(([, text]) => text)).toEqual(
      expect.arrayContaining([
        '忠誠點數：\nfirst：1,234,567 點\nsecond：無法取得',
        '忠誠點數：\nsecond：9,876 點',
      ]),
    );
    expect(harness.api.setMyCommands).toHaveBeenCalledWith(
      expect.arrayContaining([
        { command: 'points', description: '顯示忠誠點數' },
      ]),
    );
  });

  it('沒有 active session 時忠誠點數指令回覆提示', async () => {
    const harness = createHarness([update(1, '42', '/points')], []);

    await harness.bot.start();
    await vi.waitFor(() => {
      expect(harness.api.sendMessage).toHaveBeenCalledWith(
        '42',
        '目前沒有正在觀看的頻道可查詢忠誠點數。',
      );
    });
    await harness.bot.stop('test');
  });

  it('未指定頻道時回傳所有 active session 截圖', async () => {
    const harness = createHarness(
      [update(1, '42', '/screenshot')],
      ['first', 'second'],
    );

    await harness.bot.start();
    await vi.waitFor(() => {
      expect(harness.api.sendPhoto).toHaveBeenCalledTimes(2);
    });
    await harness.bot.stop('test');

    expect(harness.api.sendPhoto).toHaveBeenNthCalledWith(
      1,
      '42',
      Buffer.from('screenshot:first'),
      'first.png',
      'first 目前瀏覽器畫面',
    );
    expect(harness.api.sendPhoto).toHaveBeenNthCalledWith(
      2,
      '42',
      Buffer.from('screenshot:second'),
      'second.png',
      'second 目前瀏覽器畫面',
    );
    expect(
      harness.sessionManager.captureScreenshot,
    ).toHaveBeenNthCalledWith(1, 'first');
    expect(
      harness.sessionManager.captureScreenshot,
    ).toHaveBeenNthCalledWith(2, 'second');
  });

  it('未指定頻道截圖遇到 stale session 時會跳過並繼續回傳可用頻道', async () => {
    const harness = createHarness(
      [update(1, '42', '/screenshot')],
      ['first', 'second'],
    );
    vi.mocked(harness.sessionManager.captureScreenshot)
      .mockRejectedValueOnce(new Error('Target page has been closed'))
      .mockResolvedValueOnce({
        channel: 'second',
        image: Buffer.from('screenshot:second'),
      });

    await harness.bot.start();
    await vi.waitFor(() => {
      expect(harness.api.sendPhoto).toHaveBeenCalledOnce();
    });
    await harness.bot.stop('test');

    expect(harness.api.sendPhoto).toHaveBeenCalledWith(
      '42',
      Buffer.from('screenshot:second'),
      'second.png',
      'second 目前瀏覽器畫面',
    );
    expect(harness.logger.warn).toHaveBeenCalledWith(
      'telegram_screenshot_failed',
      {
        channel: 'first',
        error: 'Target page has been closed',
      },
    );
  });

  it('可由指令更新頻道清單與最大同時觀看', async () => {
    const harness = createHarness([
      update(1, '42', '/config'),
      update(2, '42', '/channel_add third'),
      update(3, '42', '/max_streams 2'),
      update(4, '42', '/channel_remove first'),
      update(5, '42', '/channels_set alpha,beta gamma'),
    ]);

    await harness.bot.start();
    await vi.waitFor(() => {
      expect(harness.runtimeConfigManager.setChannels).toHaveBeenCalledTimes(3);
    });
    await harness.bot.stop('test');

    expect(harness.runtimeConfigManager.setChannels).toHaveBeenNthCalledWith(
      1,
      ['first', 'second', 'third'],
    );
    expect(
      harness.runtimeConfigManager.setMaxConcurrentStreams,
    ).toHaveBeenCalledWith(2);
    expect(harness.runtimeConfigManager.setChannels).toHaveBeenNthCalledWith(
      2,
      ['second', 'third'],
    );
    expect(harness.runtimeConfigManager.setChannels).toHaveBeenNthCalledWith(
      3,
      ['alpha', 'beta', 'gamma'],
    );
    expect(
      harness.api.sendMessage.mock.calls.some(([, text]) =>
        text.includes('監控頻道：first、second'),
      ),
    ).toBe(true);
  });
});

function createHarness(
  updates: readonly TelegramUpdate[],
  activeChannels: readonly string[] = ['first', 'second'],
) {
  let served = false;
  const getUpdates = vi.fn<TelegramApi['getUpdates']>(
    async (_offset, _timeout, signal) => {
      if (!served) {
        served = true;
        return updates;
      }
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return [];
    },
  );
  const sendMessage = vi
    .fn<TelegramApi['sendMessage']>()
    .mockResolvedValue(undefined);
  const setMyCommands = vi
    .fn<TelegramApi['setMyCommands']>()
    .mockResolvedValue(undefined);
  const sendPhoto = vi
    .fn<TelegramApi['sendPhoto']>()
    .mockResolvedValue(undefined);
  const api = { getUpdates, setMyCommands, sendMessage, sendPhoto };
  const scheduler = {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    runOnce: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => ({
      running: true,
      checkInFlight: false,
      lastCheckedAt: '2026-06-14T00:00:00.000Z',
      channels: [
        { channel: 'first', isLive: true },
        { channel: 'second', isLive: false },
      ],
    })),
  } satisfies WatchdogScheduler;
  let runtimeConfig = {
    channels: [...activeChannels],
    maxConcurrentStreams: Math.min(2, activeChannels.length),
  };
  const setChannels = vi.fn(async (channels: readonly string[]) => {
    runtimeConfig = {
      channels: [...channels],
      maxConcurrentStreams: Math.min(
        runtimeConfig.maxConcurrentStreams,
        channels.length,
      ),
    };
    return runtimeConfig;
  });
  const setMaxConcurrentStreams = vi.fn(async (value: number) => {
    runtimeConfig = {
      channels: [...runtimeConfig.channels],
      maxConcurrentStreams: value,
    };
    return runtimeConfig;
  });
  const runtimeConfigManager = {
    getConfig: vi.fn(() => runtimeConfig),
    setChannels,
    setMaxConcurrentStreams,
  };
  const sessionManager = {
    reconcile: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
    getActiveChannels: vi.fn(() => [...activeChannels]),
    getRefreshStatuses: vi.fn(() =>
      activeChannels.map((channel, index) => ({
        channel,
        enabled: true,
        nextRefreshAt: `2026-06-14T00:0${index + 4}:00.000Z`,
        secondsUntilRefresh: 240 + index * 60,
      })),
    ),
    refreshPages: vi.fn(async (requestedChannel?: string) => {
      const selectedChannels = requestedChannel === undefined
        ? [...activeChannels]
        : activeChannels.filter(
          (channel) =>
            channel.toLowerCase() === requestedChannel.toLowerCase(),
        );
      return selectedChannels.map((channel) => ({
        channel,
        status: 'refreshed' as const,
      }));
    }),
    captureScreenshot: vi.fn(async (channel?: string) => {
      const selected = channel ?? activeChannels[0];
      if (
        selected === undefined ||
        !activeChannels.some(
          (active) => active.toLowerCase() === selected.toLowerCase(),
        )
      ) {
        return undefined;
      }
      const actual = activeChannels.find(
        (active) => active.toLowerCase() === selected.toLowerCase(),
      ) ?? selected;
      return {
        channel: actual,
        image: Buffer.from(`screenshot:${actual}`),
      };
    }),
    getChannelPoints: vi.fn(async (channel?: string) => {
      const selectedChannels = channel === undefined
        ? [...activeChannels]
        : activeChannels.filter(
          (active) => active.toLowerCase() === channel.toLowerCase(),
        );
      return selectedChannels.map((active) => ({
        channel: active,
        status: 'available' as const,
        balance: 1_000,
        displayValue: '1K',
      }));
    }),
  } satisfies SessionManager;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
  } satisfies Logger;
  const commandContext: BotCommandContext = {
    runCheck: () => scheduler.runOnce(),
    pauseChecks: () => scheduler.stop(),
    resumeChecks: () => scheduler.start(),
    getSchedulerSnapshot: () => scheduler.getSnapshot(),
    getActiveChannels: () => sessionManager.getActiveChannels(),
    getRefreshStatuses: () => sessionManager.getRefreshStatuses(),
    refreshPages: (channel) => sessionManager.refreshPages(channel),
    captureScreenshot: (channel) => sessionManager.captureScreenshot(channel),
    getChannelPoints: (channel) => sessionManager.getChannelPoints(channel),
    getConfig: () => runtimeConfigManager.getConfig(),
    setChannels: (channels) => runtimeConfigManager.setChannels(channels),
    setMaxConcurrentStreams: (value) =>
      runtimeConfigManager.setMaxConcurrentStreams(value),
  };
  const bot = new DefaultTelegramBot({
    config: createTestConfig({
      telegram: {
        enabled: true,
        botToken: 'test-token',
        allowedChatIds: ['42'],
        pollingTimeoutSeconds: 25,
      },
    }),
    api,
    commandContext,
    logger,
  });

  return {
    api,
    bot,
    logger,
    runtimeConfigManager,
    scheduler,
    sessionManager,
  };
}

function update(
  updateId: number,
  chatId: string,
  text: string,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: chatId },
    },
  };
}
