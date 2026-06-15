import { describe, expect, it, vi } from 'vitest';

import {
  CIRCULAR_VALUE,
  JsonLineLogger,
  LOG_EVENTS,
  REDACTED_VALUE,
  redactSensitiveData,
  type LoggerOutput,
} from '../../src/logging/index.js';

const FIXED_TIME = new Date('2026-06-14T12:00:00.000Z');

function createCapture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  const lines: string[] = [];
  const output: LoggerOutput = {
    write(line: string): void {
      lines.push(line);
    },
  };
  const logger = new JsonLineLogger({
    level,
    output,
    now: () => FIXED_TIME,
  });

  return { lines, logger };
}

describe('JsonLineLogger', () => {
  it('輸出 debug、info、warn 與 error 訊息', () => {
    const { lines, logger } = createCapture();

    logger.debug('debug_event', { value: 1 });
    logger.info('info_event', { value: 2 });
    logger.warn('warn_event', { value: 3 });
    logger.error('error_event', { value: 4 });

    expect(lines).toHaveLength(4);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        level: 'debug',
        event: 'debug_event',
        time: FIXED_TIME.toISOString(),
        value: 1,
      },
      {
        level: 'info',
        event: 'info_event',
        time: FIXED_TIME.toISOString(),
        value: 2,
      },
      {
        level: 'warn',
        event: 'warn_event',
        time: FIXED_TIME.toISOString(),
        value: 3,
      },
      {
        level: 'error',
        event: 'error_event',
        time: FIXED_TIME.toISOString(),
        value: 4,
      },
    ]);
  });

  it('依最低層級過濾訊息', () => {
    const { lines, logger } = createCapture('warn');

    logger.debug('debug_event');
    logger.info('info_event');
    logger.warn('warn_event');
    logger.error('error_event');

    expect(lines.map((line) => JSON.parse(line).level)).toEqual([
      'warn',
      'error',
    ]);
  });

  it('每次輸出恰好一行可解析 JSON 並保護保留欄位', () => {
    const { lines, logger } = createCapture();

    logger.info('format_event', {
      level: 'forged',
      event: 'forged',
      time: 'forged',
      message: 'first line\nsecond line',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(lines[0]?.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      level: 'info',
      event: 'format_event',
      time: FIXED_TIME.toISOString(),
      message: 'first line\nsecond line',
    });
  });

  it('遞迴遮罩大小寫不同的巢狀 object 與 array 敏感欄位', () => {
    const secretValues = [
      'cookie-secret',
      'cookies-secret',
      'token-secret',
      'access-snake-secret',
      'access-camel-secret',
      'oauth-secret',
      'authorization-secret',
      'storage-state-secret',
    ];
    const input = {
      profile: {
        Cookie: secretValues[0],
        nested: [
          { COOKIES: secretValues[1] },
          {
            token: secretValues[2],
            access_token: secretValues[3],
            accessToken: secretValues[4],
          },
          {
            OAuth: secretValues[5],
            AUTHORIZATION: secretValues[6],
            storageState: secretValues[7],
          },
        ],
      },
      channel: 'streamer_one',
    };

    const sanitized = redactSensitiveData(input);
    const serialized = JSON.stringify(sanitized);

    for (const secret of secretValues) {
      expect(serialized).not.toContain(secret);
    }
    expect(sanitized).toEqual({
      profile: {
        Cookie: REDACTED_VALUE,
        nested: [
          { COOKIES: REDACTED_VALUE },
          {
            token: REDACTED_VALUE,
            access_token: REDACTED_VALUE,
            accessToken: REDACTED_VALUE,
          },
          {
            OAuth: REDACTED_VALUE,
            AUTHORIZATION: REDACTED_VALUE,
            storageState: REDACTED_VALUE,
          },
        ],
      },
      channel: 'streamer_one',
    });
  });

  it('遮罩錯誤字串中的 Bearer token 與常見敏感指派', () => {
    const secrets = [
      'bearer-secret',
      'token-secret',
      'access-secret',
      'oauth-secret',
      'cookie-one',
      'cookie-two',
      'authorization-secret',
      'storage-secret',
    ];
    const { lines, logger } = createCapture();

    logger.error('request_failed', {
      error:
        'Bearer bearer-secret token=token-secret accessToken: access-secret ' +
        'oauth_token=oauth-secret Cookie: session=cookie-one; other=cookie-two',
      details:
        'authorization=authorization-secret, storage_state: storage-secret',
    });

    const serialized = lines[0] ?? '';
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain(REDACTED_VALUE);
  });

  it('遮罩錯誤字串中直接內嵌的 storageState 與 cookie 結構', () => {
    const { lines, logger } = createCapture();

    logger.error('invalid_credentials', {
      storageError:
        'storageState={"cookies":[{"name":"auth-token","value":"storage-secret"}],"origins":[]}',
      cookieError:
        'Cookies: session=cookie-secret; persistent=second-cookie-secret',
    });

    const serialized = lines[0] ?? '';
    expect(serialized).not.toContain('storage-secret');
    expect(serialized).not.toContain('cookie-secret');
    expect(serialized).not.toContain('second-cookie-secret');
  });

  it('安全序列化 Error、Error cause 與循環資料', () => {
    const { lines, logger } = createCapture();
    const cause = new Error('token=cause-secret');
    const error = new Error('request failed: Bearer error-secret', { cause });
    Object.assign(error, {
      accessToken: 'property-secret',
      context: { authorization: 'nested-secret' },
    });
    const cyclic: Record<string, unknown> = { error };
    cyclic.self = cyclic;

    logger.error('cyclic_error', { cyclic });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '');
    expect(parsed.cyclic.self).toBe(CIRCULAR_VALUE);
    expect(parsed.cyclic.error.name).toBe('Error');
    expect(parsed.cyclic.error.message).toContain(REDACTED_VALUE);
    expect(parsed.cyclic.error.cause.message).toContain(REDACTED_VALUE);
    expect(parsed.cyclic.error.accessToken).toBe(REDACTED_VALUE);
    expect(parsed.cyclic.error.context.authorization).toBe(REDACTED_VALUE);
    expect(lines[0]).not.toContain('cause-secret');
    expect(lines[0]).not.toContain('error-secret');
    expect(lines[0]).not.toContain('property-secret');
    expect(lines[0]).not.toContain('nested-secret');
  });

  it('提供完整且不重複的必要事件名稱，且每個事件都有標準欄位', () => {
    const { lines, logger } = createCapture();
    expect(Object.values(LOG_EVENTS)).toEqual([
      'service_started',
      'config_loaded',
      'config_error',
      'credential_checked',
      'twitch_api_auth_failed',
      'stream_online',
      'stream_offline',
      'watch_started',
      'watch_stopped',
      'reward_claimed',
      'reward_claim_failed',
      'drop_claimed',
      'drop_claim_failed',
      'browser_restarted',
      'page_health_failed',
      'service_stopped',
    ]);
    expect(new Set(Object.values(LOG_EVENTS)).size).toBe(
      Object.values(LOG_EVENTS).length,
    );

    for (const event of Object.values(LOG_EVENTS)) {
      logger.info(event, { channel: 'streamer_one' });
    }

    expect(lines).toHaveLength(Object.values(LOG_EVENTS).length);
    for (const [index, event] of Object.values(LOG_EVENTS).entries()) {
      expect(JSON.parse(lines[index] ?? '')).toEqual({
        level: 'info',
        event,
        time: FIXED_TIME.toISOString(),
        channel: 'streamer_one',
      });
    }
  });

  it('flush 委派給注入的輸出目的地', async () => {
    const flush = vi.fn(async () => undefined);
    const output: LoggerOutput = {
      write(): void {},
      flush,
    };
    const logger = new JsonLineLogger({ output });

    await logger.flush();

    expect(flush).toHaveBeenCalledOnce();
  });
});
