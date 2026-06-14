import { describe, expect, it, vi } from 'vitest';

import {
  TelegramApiClient,
  TelegramApiError,
} from '../../src/telegram/index.js';

describe('TelegramApiClient', () => {
  it('以 POST JSON 呼叫 getUpdates 與 sendMessage', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: [{ update_id: 7 }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { message_id: 9 },
      })));
    const client = new TelegramApiClient({
      botToken: 'test-bot-token',
      fetch: fetchMock,
    });
    const controller = new AbortController();

    await expect(
      client.getUpdates(5, 25, controller.signal),
    ).resolves.toEqual([{ update_id: 7 }]);
    await client.sendMessage('-100123', 'hello');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.telegram.org/bottest-bot-token/getUpdates',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({
          offset: 5,
          timeout: 25,
          allowed_updates: ['message'],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.telegram.org/bottest-bot-token/sendMessage',
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: '-100123',
          text: 'hello',
        }),
      }),
    );
  });

  it('網路錯誤不包含 bot token 或完整 URL', async () => {
    const secret = '123456:telegram-secret';
    const client = new TelegramApiClient({
      botToken: secret,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(
        new Error(`failed https://api.telegram.org/bot${secret}`),
      ),
    });

    const error = await captureError(client.sendMessage('1', 'hello'));

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain('api.telegram.org');
  });

  it('API 拒絕時不轉送 Telegram description 內容', async () => {
    const client = new TelegramApiClient({
      botToken: 'safe-test-token',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            description: 'secret remote details',
          }),
          { status: 401 },
        ),
      ),
    });

    const error = await captureError(client.sendMessage('1', 'hello'));

    expect(String(error)).toContain('Telegram API rejected sendMessage');
    expect(String(error)).not.toContain('secret remote details');
  });
});

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error('預期 promise 失敗');
  } catch (error: unknown) {
    return error;
  }
}
