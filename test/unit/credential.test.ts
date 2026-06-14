import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/config/index.js';
import {
  FileCredentialValidator,
  StorageStateFormatError,
  StorageStateNotFoundError,
  StorageStateParseError,
  StorageStateUnreadableError,
  type CredentialLogger,
  type CredentialReadFile,
} from '../../src/credentials/index.js';
import { LOG_EVENTS } from '../../src/logging/index.js';

const fixtureDirectory = fileURLToPath(
  new URL('../fixtures/credentials/', import.meta.url),
);
const ACCESS_TOKEN_SECRET = 'fixture-access-token-must-not-leak';
const COOKIE_SECRET = 'fixture-cookie-value-must-not-leak';

describe('FileCredentialValidator', () => {
  it('找不到 storageState 時拋出可行動的專用錯誤', async () => {
    const path = join(fixtureDirectory, 'does-not-exist.json');
    const validator = new FileCredentialValidator();

    const error = await captureError(validator.validate(createConfig(path)));

    expect(error).toBeInstanceOf(StorageStateNotFoundError);
    expect(error).toMatchObject({
      name: 'StorageStateNotFoundError',
      storageStatePath: path,
    });
    expect(String(error)).toContain('找不到登入狀態檔案');
    expect(String(error)).toContain(
      '請重新匯出 Playwright storageState 並掛載到容器',
    );
  });

  it('readFile 失敗時穩定區分不可讀，不依賴檔案權限或 root 身分', async () => {
    const path = '/mounted/storage-state.json';
    const readFile = vi.fn<CredentialReadFile>().mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );
    const validator = new FileCredentialValidator({ readFile });

    const error = await captureError(validator.validate(createConfig(path)));

    expect(readFile).toHaveBeenCalledWith(path, 'utf8');
    expect(error).toBeInstanceOf(StorageStateUnreadableError);
    expect(error).toMatchObject({
      name: 'StorageStateUnreadableError',
      storageStatePath: path,
    });
    expect(String(error)).toContain('無法讀取登入狀態檔案');
    expect(String(error)).toContain('具有讀取權限');
    expect(String(error)).not.toContain('permission denied');
  });

  it('JSON 語法錯誤時拋出安全且可行動的專用錯誤', async () => {
    const path = fixturePath('invalid-json-storage-state.json');
    const validator = new FileCredentialValidator();

    const error = await captureError(validator.validate(createConfig(path)));

    expect(error).toBeInstanceOf(StorageStateParseError);
    expect(error).toMatchObject({
      name: 'StorageStateParseError',
      storageStatePath: path,
    });
    expect(String(error)).toContain('登入狀態檔案格式錯誤');
    expect(String(error)).toContain(
      '請重新匯出有效的 Playwright storageState JSON',
    );
    expect(String(error)).not.toContain(COOKIE_SECRET);
    expect(String(error)).not.toContain(ACCESS_TOKEN_SECRET);
  });

  it.each([
    [
      '頂層不是物件',
      'invalid-top-level-storage-state.json',
      'JSON 頂層必須是物件',
    ],
    [
      'cookies 不是陣列',
      'invalid-cookies-storage-state.json',
      'cookies 若存在必須是陣列',
    ],
    [
      'origins 不是陣列',
      'invalid-origins-storage-state.json',
      'origins 若存在必須是陣列',
    ],
  ])('%s 時拋出格式錯誤', async (_name, fixture, message) => {
    const validator = new FileCredentialValidator();

    const error = await captureError(
      validator.validate(createConfig(fixturePath(fixture))),
    );

    expect(error).toBeInstanceOf(StorageStateFormatError);
    expect(String(error)).toContain(message);
    expect(String(error)).toContain(
      '請重新匯出有效的 Playwright storageState JSON',
    );
    expect(String(error)).not.toContain(COOKIE_SECRET);
    expect(String(error)).not.toContain(ACCESS_TOKEN_SECRET);
  });

  it('合法 storageState 回傳安全摘要並記錄 credential_checked', async () => {
    const logger = createLogger();
    const path = fixturePath('valid-storage-state.json');
    const validator = new FileCredentialValidator({ logger });

    const result = await validator.validate(createConfig(path));

    expect(result).toEqual({
      storageStatePath: path,
      hasCookies: true,
      twitchApiConfigured: true,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      LOG_EVENTS.CREDENTIAL_CHECKED,
      result,
    );
  });

  it('cookies 為空時警告但允許啟動', async () => {
    const logger = createLogger();
    const path = fixturePath('empty-cookies-storage-state.json');
    const validator = new FileCredentialValidator({ logger });

    const result = await validator.validate(createConfig(path));

    expect(result).toEqual({
      storageStatePath: path,
      hasCookies: false,
      twitchApiConfigured: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'credential_storage_state_empty_cookies',
      result,
    );
    expect(logger.info).toHaveBeenCalledWith(
      LOG_EVENTS.CREDENTIAL_CHECKED,
      result,
    );
  });

  it('cookies 與 origins 可缺省，並將缺少 cookies 視為空值警告', async () => {
    const logger = createLogger();
    const readFile = vi.fn<CredentialReadFile>().mockResolvedValue('{}');
    const validator = new FileCredentialValidator({ logger, readFile });

    const result = await validator.validate(
      createConfig('/mounted/storage-state.json'),
    );

    expect(result.hasCookies).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('API 設定摘要只回報是否已設定，不驗證 token 有效性', async () => {
    const readFile = vi
      .fn<CredentialReadFile>()
      .mockResolvedValue('{"cookies":[],"origins":[]}');
    const validator = new FileCredentialValidator({ readFile });

    const configured = await validator.validate(
      createConfig('/state.json', 'unknown-but-present-token'),
    );
    const missing = await validator.validate({
      ...createConfig('/state.json'),
      twitchApi: {
        clientId: 'fixture-client-id',
        accessToken: '',
      },
    });

    expect(configured.twitchApiConfigured).toBe(true);
    expect(missing.twitchApiConfigured).toBe(false);
  });

  it('錯誤、結果與所有日誌皆不包含 cookie value 或 access token', async () => {
    const logger = createLogger();
    const readFile = vi.fn<CredentialReadFile>().mockResolvedValue(
      JSON.stringify({
        cookies: [
          {
            name: 'auth-token',
            value: COOKIE_SECRET,
          },
        ],
        origins: [],
      }),
    );
    const validator = new FileCredentialValidator({ logger, readFile });

    const result = await validator.validate(
      createConfig('/mounted/storage-state.json'),
    );
    const serializedOutput = JSON.stringify({
      result,
      info: logger.info.mock.calls,
      warn: logger.warn.mock.calls,
    });

    expect(serializedOutput).not.toContain(COOKIE_SECRET);
    expect(serializedOutput).not.toContain(ACCESS_TOKEN_SECRET);
    expect(serializedOutput).not.toContain('auth-token');
  });

  it('底層 readFile 錯誤即使含敏感資料也不會進入公開錯誤', async () => {
    const readFile = vi.fn<CredentialReadFile>().mockRejectedValue(
      Object.assign(
        new Error(
          `cookie=${COOKIE_SECRET} access_token=${ACCESS_TOKEN_SECRET}`,
        ),
        { code: 'EACCES' },
      ),
    );
    const validator = new FileCredentialValidator({ readFile });

    const error = await captureError(
      validator.validate(createConfig('/mounted/storage-state.json')),
    );
    const serializedError = JSON.stringify(error);

    expect(String(error)).not.toContain(COOKIE_SECRET);
    expect(String(error)).not.toContain(ACCESS_TOKEN_SECRET);
    expect(serializedError).not.toContain(COOKIE_SECRET);
    expect(serializedError).not.toContain(ACCESS_TOKEN_SECRET);
  });
});

function fixturePath(name: string): string {
  return join(fixtureDirectory, name);
}

function createConfig(
  storageStatePath: string,
  accessToken = ACCESS_TOKEN_SECRET,
): AppConfig {
  return {
    channels: ['streamer_one'],
    checkIntervalSeconds: 60,
    maxConcurrentStreams: 1,
    headless: true,
    storageStatePath,
    logLevel: 'info',
    twitchApi: {
      clientId: 'fixture-client-id',
      accessToken,
    },
    browser: {
      navigationTimeoutMs: 30_000,
      pageHealthCheckIntervalSeconds: 30,
      rewardCheckIntervalSeconds: 15,
      restartOnCrash: true,
    },
  };
}

function createLogger(): {
  readonly info: ReturnType<typeof vi.fn<CredentialLogger['info']>>;
  readonly warn: ReturnType<typeof vi.fn<CredentialLogger['warn']>>;
} {
  return {
    info: vi.fn<CredentialLogger['info']>(),
    warn: vi.fn<CredentialLogger['warn']>(),
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error('預期 promise 拋出錯誤');
  } catch (error: unknown) {
    return error;
  }
}
