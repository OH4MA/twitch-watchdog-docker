import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LOG_EVENTS,
  type Logger,
} from '../../src/logging/index.js';
import {
  TwitchApiAuthError,
  TwitchApiClient,
  TwitchApiRateLimitError,
  TwitchApiTemporaryError,
  type TwitchApiClientOptions,
} from '../../src/twitch/index.js';

const FIXED_TIME = new Date('2026-06-14T12:00:00.000Z');
const CLIENT_ID = 'fixture-client-id';
const ACCESS_TOKEN = 'fixture-access-token';

afterEach(() => {
  vi.useRealTimers();
});

describe('TwitchApiClient', () => {
  it('使用 URLSearchParams 與必要 headers 查詢多頻道並轉換部分 live', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          helixStream({
            id: 'stream-two',
            user_login: 'streamer_two',
            title: 'Second stream',
            started_at: '2026-06-14T11:30:00.000Z',
            viewer_count: 42,
          }),
          helixStream({
            id: 'stream-one',
            user_login: 'streamer_one',
            title: 'First stream',
            started_at: '2026-06-14T11:00:00.000Z',
            viewer_count: 100,
          }),
        ],
      }),
    );
    const client = createClient({ fetch: fetchMock });

    const statuses = await client.getLiveStatuses([
      'streamer_one',
      'offline_channel',
      'streamer_two',
    ]);

    expect(statuses).toEqual([
      {
        channel: 'streamer_one',
        isLive: true,
        streamId: 'stream-one',
        title: 'First stream',
        startedAt: '2026-06-14T11:00:00.000Z',
        viewerCount: 100,
        checkedAt: FIXED_TIME.toISOString(),
      },
      {
        channel: 'offline_channel',
        isLive: false,
        checkedAt: FIXED_TIME.toISOString(),
      },
      {
        channel: 'streamer_two',
        isLive: true,
        streamId: 'stream-two',
        title: 'Second stream',
        startedAt: '2026-06-14T11:30:00.000Z',
        viewerCount: 42,
        checkedAt: FIXED_TIME.toISOString(),
      },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = requireFetchCall(fetchMock);
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.twitch.tv');
    expect(url.pathname).toBe('/helix/streams');
    expect(url.searchParams.getAll('user_login')).toEqual([
      'streamer_one',
      'offline_channel',
      'streamer_two',
    ]);
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    const headers = new Headers(init.headers);
    expect(headers.get('Client-Id')).toBe(CLIENT_ID);
    expect(headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('data 為空時依設定順序回傳所有 offline', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ data: [] }));
    const client = createClient({ fetch: fetchMock });

    await expect(
      client.getLiveStatuses(['one', 'two', 'three']),
    ).resolves.toEqual([
      {
        channel: 'one',
        isLive: false,
        checkedAt: FIXED_TIME.toISOString(),
      },
      {
        channel: 'two',
        isLive: false,
        checkedAt: FIXED_TIME.toISOString(),
      },
      {
        channel: 'three',
        isLive: false,
        checkedAt: FIXED_TIME.toISOString(),
      },
    ]);
  });

  it('API 回傳順序不同與 login 大小寫不同時仍保持設定順序', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          helixStream({ id: 'third', user_login: 'THREE' }),
          helixStream({ id: 'first', user_login: 'one' }),
        ],
      }),
    );
    const client = createClient({ fetch: fetchMock });

    const statuses = await client.getLiveStatuses(['One', 'two', 'three']);

    expect(statuses.map(({ channel, isLive }) => ({ channel, isLive }))).toEqual([
      { channel: 'One', isLive: true },
      { channel: 'two', isLive: false },
      { channel: 'three', isLive: true },
    ]);
  });

  it('超過 100 個 user_login 時分批查詢且保持完整設定順序', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ data: [] }));
    const client = createClient({ fetch: fetchMock });
    const channels = Array.from(
      { length: 205 },
      (_, index) => `channel_${index}`,
    );

    const statuses = await client.getLiveStatuses(channels);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.map(([input]) =>
        new URL(String(input)).searchParams.getAll('user_login').length,
      ),
    ).toEqual([100, 100, 5]);
    expect(
      fetchMock.mock.calls.flatMap(([input]) =>
        new URL(String(input)).searchParams.getAll('user_login'),
      ),
    ).toEqual(channels);
    expect(statuses.map((status) => status.channel)).toEqual(channels);
  });

  it('空頻道清單不發送 request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createClient({ fetch: fetchMock });

    await expect(client.getLiveStatuses([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403] as const)(
    'HTTP %s 記錄 auth 事件並拋出可分類錯誤',
    async (statusCode) => {
      const logger = createLoggerMock();
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: statusCode }));
      const client = createClient({ fetch: fetchMock, logger });

      const error = await captureError(
        client.getLiveStatuses(['streamer']),
      );

      expect(error).toBeInstanceOf(TwitchApiAuthError);
      expect(error).toMatchObject({
        kind: 'auth',
        statusCode,
      });
      expect(logger.error).toHaveBeenCalledWith(
        LOG_EVENTS.TWITCH_API_AUTH_FAILED,
        { statusCode },
      );
    },
  );

  it('HTTP 429 優先使用 Ratelimit-Reset epoch seconds', async () => {
    const retryAt = new Date(FIXED_TIME.getTime() + 90_000);
    const logger = createLoggerMock();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: {
          'Ratelimit-Reset': String(retryAt.getTime() / 1_000),
        },
      }),
    );
    const client = createClient({ fetch: fetchMock, logger });

    const error = await captureError(
      client.getLiveStatuses(['streamer']),
    );

    expect(error).toBeInstanceOf(TwitchApiRateLimitError);
    expect(error).toMatchObject({
      kind: 'rate-limit',
      retryAfterMs: 90_000,
    });
    expect((error as TwitchApiRateLimitError).retryAt).toEqual(retryAt);
    expect(logger.warn).toHaveBeenCalledWith('twitch_api_rate_limited', {
      statusCode: 429,
      retryAt: retryAt.toISOString(),
      retryAfterMs: 90_000,
    });
  });

  it('HTTP 429 遠期 Ratelimit-Reset 最多只退避五分鐘', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { 'Ratelimit-Reset': '253402300799' },
      }),
    );
    const client = createClient({ fetch: fetchMock });

    const error = await captureError(
      client.getLiveStatuses(['streamer']),
    );

    expect(error).toMatchObject({
      kind: 'rate-limit',
      retryAfterMs: 300_000,
      retryAt: new Date(FIXED_TIME.getTime() + 300_000),
    });
  });

  it.each([
    [60, 120_000],
    [200, 300_000],
  ])(
    'HTTP 429 reset 無法解析時以 %s 秒輪詢間隔計算 fallback',
    async (checkIntervalSeconds, expectedRetryAfterMs) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          status: 429,
          headers: { 'Ratelimit-Reset': 'invalid' },
        }),
      );
      const client = createClient({
        fetch: fetchMock,
        checkIntervalSeconds,
      });

      const error = await captureError(
        client.getLiveStatuses(['streamer']),
      );

      expect(error).toBeInstanceOf(TwitchApiRateLimitError);
      expect(error).toMatchObject({
        kind: 'rate-limit',
        retryAfterMs: expectedRetryAfterMs,
      });
      expect((error as TwitchApiRateLimitError).retryAt).toEqual(
        new Date(FIXED_TIME.getTime() + expectedRetryAfterMs),
      );
    },
  );

  it.each([500, 503])(
    'HTTP %s 拋出 temporary server 錯誤',
    async (statusCode) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: statusCode }));
      const client = createClient({ fetch: fetchMock });

      await expect(
        client.getLiveStatuses(['streamer']),
      ).rejects.toMatchObject({
        name: 'TwitchApiTemporaryError',
        kind: 'temporary',
        reason: 'server',
        statusCode,
      });
    },
  );

  it('request timeout 會中止 fetch 並拋出 temporary timeout 錯誤', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const client = createClient({
      fetch: fetchMock,
      requestTimeoutMs: 1_000,
    });

    const request = client.getLiveStatuses(['streamer']);
    const assertion = expect(request).rejects.toMatchObject({
      name: 'TwitchApiTemporaryError',
      kind: 'temporary',
      reason: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
  });

  it('request timeout 會涵蓋收到 headers 後的 response body', async () => {
    vi.useFakeTimers();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = createClient({
      fetch: fetchMock,
      requestTimeoutMs: 1_000,
    });

    const request = client.getLiveStatuses(['streamer']);
    const assertion = expect(request).rejects.toMatchObject({
      name: 'TwitchApiTemporaryError',
      kind: 'temporary',
      reason: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    controller?.error(new DOMException('aborted', 'AbortError'));

    await assertion;
  });

  it('拒絕超過一百萬 bytes 的 response body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '1000001',
        },
      }),
    );
    const client = createClient({ fetch: fetchMock });

    await expect(
      client.getLiveStatuses(['streamer']),
    ).rejects.toMatchObject({
      name: 'TwitchApiTemporaryError',
      kind: 'temporary',
      reason: 'invalid-response',
    });
  });

  it('fetch AbortError 分類為 temporary aborted 錯誤', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const client = createClient({ fetch: fetchMock });

    await expect(
      client.getLiveStatuses(['streamer']),
    ).rejects.toMatchObject({
      name: 'TwitchApiTemporaryError',
      kind: 'temporary',
      reason: 'aborted',
    });
  });

  it('網路錯誤分類為 temporary 且不轉送原始錯誤內容', async () => {
    const secret = 'network-error-secret';
    const logger = createLoggerMock();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error(`Authorization: Bearer ${secret} request failed`),
      );
    const client = createClient({
      fetch: fetchMock,
      accessToken: secret,
      logger,
    });

    const error = await captureError(
      client.getLiveStatuses(['streamer']),
    );
    const serialized = `${String(error)} ${JSON.stringify(error)} ${JSON.stringify(
      loggerCalls(logger),
    )}`;

    expect(error).toBeInstanceOf(TwitchApiTemporaryError);
    expect(error).toMatchObject({
      kind: 'temporary',
      reason: 'network',
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
  });

  it('無法解析的 JSON 分類為 temporary invalid-response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"data":[', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = createClient({ fetch: fetchMock });

    await expect(
      client.getLiveStatuses(['streamer']),
    ).rejects.toMatchObject({
      name: 'TwitchApiTemporaryError',
      kind: 'temporary',
      reason: 'invalid-response',
      statusCode: 200,
    });
  });

  it.each([
    ['缺少 data', {}],
    ['data 不是陣列', { data: {} }],
    [
      'stream 欄位缺少',
      { data: [{ id: 'stream-id', user_login: 'streamer' }] },
    ],
    [
      'viewer_count 不是非負整數',
      {
        data: [
          helixStream({
            user_login: 'streamer',
            viewer_count: -1,
          }),
        ],
      },
    ],
    [
      'started_at 不是時間',
      {
        data: [
          helixStream({
            user_login: 'streamer',
            started_at: 'not-a-time',
          }),
        ],
      },
    ],
    [
      '同一 login 重複',
      {
        data: [
          helixStream({ id: 'one', user_login: 'streamer' }),
          helixStream({ id: 'two', user_login: 'STREAMER' }),
        ],
      },
    ],
  ])('%s 時保守拒絕 response schema', async (_name, payload) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(payload));
    const client = createClient({ fetch: fetchMock });

    await expect(
      client.getLiveStatuses(['streamer']),
    ).rejects.toMatchObject({
      name: 'TwitchApiTemporaryError',
      kind: 'temporary',
      reason: 'invalid-response',
    });
  });

  it.each([401, 403, 429, 500])(
    'HTTP %s 的 error 與 logger fields 不洩漏 token 或 headers',
    async (statusCode) => {
      const secret = `secret-for-${statusCode}`;
      const logger = createLoggerMock();
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          status: statusCode,
          headers:
            statusCode === 429
              ? { 'Ratelimit-Reset': 'invalid' }
              : undefined,
        }),
      );
      const client = createClient({
        fetch: fetchMock,
        accessToken: secret,
        logger,
      });

      const error = await captureError(
        client.getLiveStatuses(['streamer']),
      );
      const serialized = `${String(error)} ${JSON.stringify(error)} ${JSON.stringify(
        loggerCalls(logger),
      )}`;

      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('Client-Id');
      expect(serialized).not.toContain('Bearer');
    },
  );
});

function createClient(
  overrides: Partial<TwitchApiClientOptions> = {},
): TwitchApiClient {
  return new TwitchApiClient({
    clientId: CLIENT_ID,
    accessToken: ACCESS_TOKEN,
    checkIntervalSeconds: 60,
    logger: createLoggerMock(),
    now: () => FIXED_TIME,
    ...overrides,
  });
}

function createLoggerMock(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
  };
}

function loggerCalls(logger: Logger): unknown[] {
  return [
    vi.mocked(logger.debug).mock.calls,
    vi.mocked(logger.info).mock.calls,
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
  ];
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function helixStream(
  overrides: Partial<Record<
    'id' | 'started_at' | 'title' | 'user_login' | 'viewer_count',
    string | number
  >> = {},
): Record<string, unknown> {
  return {
    id: 'stream-id',
    user_login: 'streamer',
    title: 'Live title',
    started_at: '2026-06-14T11:00:00.000Z',
    viewer_count: 10,
    ...overrides,
  };
}

function requireFetchCall(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
): [string | URL | Request, RequestInit] {
  const call = fetchMock.mock.calls[0];
  if (call === undefined || call[1] === undefined) {
    throw new Error('Expected fetch to be called with init');
  }
  return [call[0], call[1]];
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected promise to reject');
}
