import { describe, expect, it, vi } from 'vitest';

import {
  DiscordApiClient,
  DiscordApiError,
} from '../../src/discord/index.js';

describe('DiscordApiClient', () => {
  it('uses Discord REST routes for gateway, commands, messages, interactions, and follow-up files', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'wss://gateway.discord.gg',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'message' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'followup' })));
    const client = new DiscordApiClient({
      botToken: 'discord-token',
      fetch: fetchMock,
    });

    await expect(
      client.getGatewayBot(AbortSignal.timeout(1_000)),
    ).resolves.toEqual({ url: 'wss://gateway.discord.gg' });
    await client.registerCommands('app-id', 'guild-id', [
      { name: 'status', description: '顯示服務與觀看狀態' },
    ]);
    await client.sendMessage('channel-id', 'hello');
    await client.sendInteractionResponse(
      'interaction-id',
      'interaction-token',
      'done',
    );
    await client.deferInteractionResponse(
      'interaction-id',
      'interaction-token',
    );
    await client.editInteractionResponse(
      'app-id',
      'interaction-token',
      'updated',
    );
    await client.sendInteractionPhoto(
      'app-id',
      'interaction-token',
      Buffer.from('png-image'),
      'channel.png',
      'channel screenshot',
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://discord.com/api/v10/gateway/bot',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bot discord-token',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://discord.com/api/v10/applications/app-id/guilds/guild-id/commands',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify([
          { name: 'status', description: '顯示服務與觀看狀態' },
        ]),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://discord.com/api/v10/channels/channel-id/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://discord.com/api/v10/interactions/interaction-id/interaction-token/callback',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 4,
          data: { content: 'done' },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'https://discord.com/api/v10/interactions/interaction-id/interaction-token/callback',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ type: 5 }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      'https://discord.com/api/v10/webhooks/app-id/interaction-token/messages/@original',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ content: 'updated' }),
      }),
    );
    const seventhCall = fetchMock.mock.calls[6];
    expect(seventhCall?.[0]).toBe(
      'https://discord.com/api/v10/webhooks/app-id/interaction-token',
    );
    expect(seventhCall?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      redirect: 'error',
    }));
    const form = seventhCall?.[1]?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) {
      throw new Error('Expected Discord file upload to use FormData');
    }
    expect(form.get('payload_json')).toBe(JSON.stringify({
      content: 'channel screenshot',
      attachments: [{ id: 0, filename: 'channel.png' }],
    }));
    const file = form.get('files[0]');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('channel.png');
  });

  it('does not expose the bot token when network requests fail', async () => {
    const secret = 'discord-secret-token';
    const client = new DiscordApiClient({
      botToken: secret,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(
        new Error(`failed Bot ${secret}`),
      ),
    });

    const error = await captureError(
      client.sendMessage('channel-id', 'hello'),
    );

    expect(error).toBeInstanceOf(DiscordApiError);
    expect(String(error)).not.toContain(secret);
  });
});

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error('預期 promise 拋出錯誤');
  } catch (error: unknown) {
    return error;
  }
}
