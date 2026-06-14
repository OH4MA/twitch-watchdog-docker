import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/logging/index.js';
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
    expect(messages).toContain('已完成一次狀態檢查。');
    expect(messages).toContain('自動檢查已暫停。');
    expect(messages).toContain('自動檢查已恢復。');
    expect(messages.some((text) => text.includes('正在觀看：first'))).toBe(
      true,
    );
    expect(messages.some((text) => text.includes('1. 🔴 first'))).toBe(
      true,
    );
    expect(messages.at(-1)).toContain('Twitch Watchdog 已停止');
    expect(harness.api.getUpdates.mock.calls[0]?.[0]).toBeUndefined();
    expect(harness.api.getUpdates.mock.calls[1]?.[0]).toBe(6);
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
        { updateId: 10 },
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

  it('尚未啟動時 stop 不傳送誤導通知', async () => {
    const harness = createHarness([]);

    await harness.bot.stop('startup_failed:browser');

    expect(harness.api.sendMessage).not.toHaveBeenCalled();
    expect(harness.api.getUpdates).not.toHaveBeenCalled();
  });
});

function createHarness(updates: readonly TelegramUpdate[]) {
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
  const api = { getUpdates, sendMessage };
  const scheduler = {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    runOnce: vi.fn(async () => undefined),
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
  const sessionManager = {
    reconcile: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
    getActiveChannels: vi.fn(() => ['first']),
  } satisfies SessionManager;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
  } satisfies Logger;
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
    scheduler,
    sessionManager,
    logger,
  });

  return { api, bot, logger, scheduler };
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
