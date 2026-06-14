import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  YamlConfigLoader,
  type AppConfig,
  type ConfigLogger,
} from '../../src/config/index.js';

const fixtureDirectory = fileURLToPath(
  new URL('../fixtures/config/', import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('YamlConfigLoader', () => {
  it('載入合法 YAML 並將 snake_case 轉為 camelCase', async () => {
    const config = await loadFixture('valid.yml');

    expect(config).toEqual({
      channels: ['streamer_one', 'streamer_two', 'streamer_three'],
      checkIntervalSeconds: 90,
      maxConcurrentStreams: 2,
      headless: false,
      storageStatePath: '/tmp/test-storage-state.json',
      logLevel: 'debug',
      twitchApi: {
        clientId: 'fixture-client-id',
        accessToken: 'fixture-access-token',
      },
      browser: {
        navigationTimeoutMs: 45_000,
        pageHealthCheckIntervalSeconds: 40,
        rewardCheckIntervalSeconds: 20,
        restartOnCrash: false,
      },
    });
  });

  it('支援正式 YAML 的引號、註解與 flow sequence', async () => {
    const config = await loadSource(`
# flow sequence 與引號內的特殊字元應由正式 YAML parser 處理
channels: ["quoted_channel", 'second_channel'] # 行尾註解
storage_state_path: "/tmp/state # 1.json"
twitch_api:
  client_id: 'client: # not a comment'
  access_token: "fixture-token"
`);

    expect(config.channels).toEqual(['quoted_channel', 'second_channel']);
    expect(config.storageStatePath).toBe('/tmp/state # 1.json');
    expect(config.twitchApi.clientId).toBe('client: # not a comment');
  });

  it('套用所有預設值並將併發數降為頻道數', async () => {
    const debug = vi.fn<ConfigLogger['debug']>();
    const config = await loadFixture('defaults.yml', {}, { debug });

    expect(config).toEqual({
      channels: ['streamer_one', 'streamer_two'],
      checkIntervalSeconds: 60,
      maxConcurrentStreams: 2,
      headless: true,
      storageStatePath: '/data/browser-state/storage-state.json',
      logLevel: 'info',
      twitchApi: {
        clientId: 'fixture-client-id',
        accessToken: 'fixture-access-token',
      },
      browser: {
        navigationTimeoutMs: 30_000,
        pageHealthCheckIntervalSeconds: 30,
        rewardCheckIntervalSeconds: 15,
        restartOnCrash: true,
      },
    });
    expect(debug).toHaveBeenCalledWith('config_concurrency_clamped', {
      requestedMaxConcurrentStreams: 3,
      effectiveMaxConcurrentStreams: 2,
      channelCount: 2,
    });
  });

  it('頻道數足夠時 max_concurrent_streams 預設為 3', async () => {
    const debug = vi.fn<ConfigLogger['debug']>();
    const config = await loadSource(
      configWithChannels([
        'streamer_one',
        'streamer_two',
        'streamer_three',
        'streamer_four',
      ]),
      {},
      { debug },
    );

    expect(config.maxConcurrentStreams).toBe(3);
    expect(debug).not.toHaveBeenCalled();
  });

  it('顯式併發數大於頻道數時降級並輸出 debug 事件', async () => {
    const debug = vi.fn<ConfigLogger['debug']>();
    const config = await loadSource(
      `${configWithChannels(['one', 'two'])}max_concurrent_streams: 8\n`,
      {},
      { debug },
    );

    expect(config.maxConcurrentStreams).toBe(2);
    expect(debug).toHaveBeenCalledWith('config_concurrency_clamped', {
      requestedMaxConcurrentStreams: 8,
      effectiveMaxConcurrentStreams: 2,
      channelCount: 2,
    });
  });

  it('替換 ${ENV_VAR} 且讓直接環境覆寫優先', async () => {
    const configPath = fixturePath('env.yml');
    const config = await new YamlConfigLoader().load('/missing/config.yml', {
      CONFIG_PATH: configPath,
      PRIMARY_CHANNEL: 'environment_channel',
      FILE_CLIENT_ID: 'file-client-id',
      FILE_ACCESS_TOKEN: 'file-access-token',
      TWITCH_CLIENT_ID: 'override-client-id',
      TWITCH_ACCESS_TOKEN: 'override-access-token',
      LOG_LEVEL: 'warn',
      HEADLESS: 'FALSE',
    });

    expect(config.channels).toEqual([
      'environment_channel',
      'static_channel',
    ]);
    expect(config.twitchApi).toEqual({
      clientId: 'override-client-id',
      accessToken: 'override-access-token',
    });
    expect(config.logLevel).toBe('warn');
    expect(config.headless).toBe(false);
  });

  it('缺少的環境替換值會成為空字串並由欄位驗證拒絕', async () => {
    await expect(
      loadFixture('env.yml', {
        PRIMARY_CHANNEL: 'environment_channel',
        FILE_CLIENT_ID: 'file-client-id',
      }),
    ).rejects.toMatchObject({
      name: 'ConfigValidationError',
      field: 'twitch_api.access_token',
    });
  });

  it('拒絕不是 true 或 false 的 HEADLESS', async () => {
    await expect(
      loadFixture('valid.yml', { HEADLESS: 'yes' }),
    ).rejects.toThrow(/headless.*true.*false/u);
  });

  it.each([
    ['缺少 channels', withoutChannels()],
    ['channels 不是陣列', validSource('channels: streamer')],
    ['channels 是空陣列', validSource('channels: []')],
    ['頻道名稱包含非法字元', validSource('channels: [good, bad-name]')],
    ['頻道名稱超過 25 字元', validSource(`channels: [${'a'.repeat(26)}]`)],
    ['頻道不是字串', validSource('channels: [123]')],
  ])('%s 時拋出 ConfigValidationError', async (_name, source) => {
    await expect(loadSource(source)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it.each([
    ['check_interval_seconds 型別錯誤', 'check_interval_seconds: "60"'],
    ['check_interval_seconds 小於 30', 'check_interval_seconds: 29'],
    ['check_interval_seconds 不是整數', 'check_interval_seconds: 30.5'],
    ['max_concurrent_streams 型別錯誤', 'max_concurrent_streams: "2"'],
    ['max_concurrent_streams 小於 1', 'max_concurrent_streams: 0'],
    ['max_concurrent_streams 不是整數', 'max_concurrent_streams: 1.5'],
    ['headless 型別錯誤', 'headless: "true"'],
    ['storage_state_path 型別錯誤', 'storage_state_path: 123'],
    ['storage_state_path 為空', 'storage_state_path: ""'],
    ['log_level 型別錯誤', 'log_level: 1'],
    ['log_level 不在允許清單', 'log_level: verbose'],
  ])('%s 時拒絕設定', async (_name, replacement) => {
    await expect(
      loadSource(validSource(replacement)),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it.each([
    ['twitch_api', 'channels: [streamer]\ntwitch_api: invalid'],
    [
      'browser',
      `${validSource('channels: [streamer]')}browser: invalid`,
    ],
  ])('%s 不是物件時拒絕設定', async (_field, source) => {
    await expect(loadSource(source)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it.each([
    ['client_id 缺少', 'access_token: fixture-access-token'],
    ['client_id 型別錯誤', 'client_id: 123\n  access_token: fixture-token'],
    ['client_id 為空', 'client_id: ""\n  access_token: fixture-token'],
    ['access_token 缺少', 'client_id: fixture-client-id'],
    ['access_token 型別錯誤', 'client_id: fixture-client-id\n  access_token: 123'],
    ['access_token 為空', 'client_id: fixture-client-id\n  access_token: ""'],
  ])('twitch_api.%s 時拒絕設定', async (_name, twitchApiBody) => {
    await expect(
      loadSource(configWithTwitchApi(twitchApiBody)),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it.each([
    ['navigation_timeout_ms', 'navigation_timeout_ms: 0'],
    ['navigation_timeout_ms 型別', 'navigation_timeout_ms: "30000"'],
    [
      'page_health_check_interval_seconds',
      'page_health_check_interval_seconds: 0',
    ],
    [
      'page_health_check_interval_seconds 型別',
      'page_health_check_interval_seconds: 1.5',
    ],
    ['reward_check_interval_seconds', 'reward_check_interval_seconds: -1'],
    [
      'reward_check_interval_seconds 型別',
      'reward_check_interval_seconds: false',
    ],
    ['restart_on_crash', 'restart_on_crash: "true"'],
  ])('browser.%s 無效時拒絕設定', async (_name, browserBody) => {
    await expect(
      loadSource(configWithBrowser(browserBody)),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('設定檔不存在時拋出 ConfigFileNotFoundError', async () => {
    const path = join(tmpdir(), 'config-does-not-exist.yml');

    await expect(
      new YamlConfigLoader().load(path, {}),
    ).rejects.toBeInstanceOf(ConfigFileNotFoundError);
    await expect(new YamlConfigLoader().load(path, {})).rejects.toMatchObject(
      { configPath: path },
    );
  });

  it('YAML 語法錯誤時拋出 ConfigParseError', async () => {
    await expect(loadFixture('parse-error.yml')).rejects.toBeInstanceOf(
      ConfigParseError,
    );
  });

  it.each([
    'channels:\n\t- channel',
    'channels: [channel,,other]',
    'channels:\n  - channel\nchannels:\n  - other',
  ])('拒絕格式錯誤的 YAML', async (source) => {
    await expect(loadSource(source)).rejects.toSatisfy((error: unknown) =>
      [ConfigParseError, ConfigValidationError].some(
        (ErrorType) => error instanceof ErrorType,
      ),
    );
  });

  it('拒絕形成循環物件的 YAML alias', async () => {
    await expect(
      loadSource(`
root: &root
  self: *root
channels: [streamer]
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
`),
    ).rejects.toBeInstanceOf(ConfigParseError);
  });

  it.each([
    ['check_interval_seconds', 'check_interval_seconds: 2147484'],
    [
      'browser.navigation_timeout_ms',
      'browser:\n  navigation_timeout_ms: 2147483648',
    ],
    [
      'browser.page_health_check_interval_seconds',
      'browser:\n  page_health_check_interval_seconds: 2147484',
    ],
    [
      'browser.reward_check_interval_seconds',
      'browser:\n  reward_check_interval_seconds: 2147484',
    ],
  ])('%s 超過 Node timer 上限時拒絕設定', async (_field, replacement) => {
    await expect(
      loadSource(validSource(replacement)),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it.each([
    ['sequence', '- root_sequence'],
    ['scalar', 'root_scalar'],
    ['null', 'null'],
  ])('%s 根節點走 ConfigValidationError', async (_kind, source) => {
    await expect(loadSource(source)).rejects.toMatchObject({
      name: 'ConfigValidationError',
      field: 'root',
    });
  });

  it('任何 parse 或 validation error 都不包含 access token 原文', async () => {
    const secret = 'never-print-this-access-token';
    const validationPromise = loadSource(
      `channels: [channel]
check_interval_seconds: 1
twitch_api:
  client_id: fixture-client-id
  access_token: ${secret}
`,
      { TWITCH_ACCESS_TOKEN: secret },
    );
    const parsePromise = loadSource(
      `channels: [channel]
twitch_api:
  client_id: fixture-client-id
  access_token: "${secret}
`,
    );

    const [validationError, parseError] = await Promise.all([
      captureError(validationPromise),
      captureError(parsePromise),
    ]);

    expect(String(validationError)).not.toContain(secret);
    expect(String(parseError)).not.toContain(secret);
  });

  it('回傳物件、陣列與巢狀設定皆不可變', async () => {
    const config = await loadFixture('valid.yml');

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.channels)).toBe(true);
    expect(Object.isFrozen(config.twitchApi)).toBe(true);
    expect(Object.isFrozen(config.browser)).toBe(true);
    expect(() => {
      (config.channels as string[]).push('another_channel');
    }).toThrow(TypeError);
    expect(() => {
      (config.twitchApi as { accessToken: string }).accessToken = 'changed';
    }).toThrow(TypeError);
  });
});

async function loadFixture(
  name: string,
  env: NodeJS.ProcessEnv = {},
  logger?: ConfigLogger,
): Promise<AppConfig> {
  return new YamlConfigLoader(logger).load(fixturePath(name), env);
}

function fixturePath(name: string): string {
  return join(fixtureDirectory, name);
}

async function loadSource(
  source: string,
  env: NodeJS.ProcessEnv = {},
  logger?: ConfigLogger,
): Promise<AppConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'twitch-config-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'config.yml');
  await writeFile(path, source, 'utf8');
  return new YamlConfigLoader(logger).load(path, env);
}

function validSource(replacement: string): string {
  return `${replacement}
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
`;
}

function withoutChannels(): string {
  return `twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
`;
}

function configWithTwitchApi(body: string): string {
  return `channels: [streamer]
twitch_api:
  ${body}
`;
}

function configWithBrowser(body: string): string {
  return `channels: [streamer]
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
browser:
  ${body}
`;
}

function configWithChannels(channels: readonly string[]): string {
  return `channels: [${channels.join(', ')}]
twitch_api:
  client_id: fixture-client-id
  access_token: fixture-access-token
`;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error('預期 promise 拋出錯誤');
  } catch (error: unknown) {
    return error;
  }
}
