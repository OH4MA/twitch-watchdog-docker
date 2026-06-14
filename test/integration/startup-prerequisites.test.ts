import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { YamlConfigLoader } from '../../src/config/index.js';
import {
  FileCredentialValidator,
  StorageStateNotFoundError,
} from '../../src/credentials/index.js';
import {
  createFixedClock,
  createRecordingLogger,
} from '../helpers/test-logger.js';

const temporaryDirectories: string[] = [];
const ACCESS_TOKEN = 'startup-token-must-remain-secret';
const COOKIE_VALUE = 'startup-cookie-must-remain-secret';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Config 與 Credential 啟動前置條件整合', () => {
  it('從暫存設定載入 env 憑證與 storageState，僅記錄安全摘要', async () => {
    const directory = await createTemporaryDirectory();
    const storageStatePath = join(directory, 'storage-state.json');
    const configPath = join(directory, 'config.yml');
    await writeFile(
      storageStatePath,
      JSON.stringify({
        cookies: [
          {
            name: 'auth-token',
            value: COOKIE_VALUE,
            domain: '.twitch.tv',
            path: '/',
          },
        ],
        origins: [],
      }),
      'utf8',
    );
    await writeFile(configPath, startupConfigSource(), 'utf8');
    const recordingLogger = createRecordingLogger(createFixedClock());
    const configLoader = new YamlConfigLoader(recordingLogger.logger);
    const credentialValidator = new FileCredentialValidator({
      logger: recordingLogger.logger,
    });

    const config = await configLoader.load(configPath, {
      TEST_STORAGE_STATE_PATH: storageStatePath,
      TWITCH_CLIENT_ID: 'startup-client-id',
      TWITCH_ACCESS_TOKEN: ACCESS_TOKEN,
    });
    const credentials = await credentialValidator.validate(config);

    expect(config.channels).toEqual(['first_channel', 'second_channel']);
    expect(config.storageStatePath).toBe(storageStatePath);
    expect(credentials).toEqual({
      storageStatePath,
      hasCookies: true,
      twitchApiConfigured: true,
    });
    expect(recordingLogger.records()).toContainEqual(
      expect.objectContaining({
        event: 'credential_checked',
        storageStatePath: '[REDACTED]',
        hasCookies: '[REDACTED]',
        twitchApiConfigured: true,
      }),
    );
    expect(recordingLogger.serialized()).not.toContain(ACCESS_TOKEN);
    expect(recordingLogger.serialized()).not.toContain(COOKIE_VALUE);
  });

  it('設定可載入但 storageState 不存在時阻止啟動前置驗證', async () => {
    const directory = await createTemporaryDirectory();
    const storageStatePath = join(directory, 'missing-storage-state.json');
    const configPath = join(directory, 'config.yml');
    await writeFile(configPath, startupConfigSource(), 'utf8');
    const recordingLogger = createRecordingLogger(createFixedClock());
    const config = await new YamlConfigLoader(
      recordingLogger.logger,
    ).load(configPath, {
      TEST_STORAGE_STATE_PATH: storageStatePath,
      TWITCH_CLIENT_ID: 'startup-client-id',
      TWITCH_ACCESS_TOKEN: ACCESS_TOKEN,
    });

    await expect(
      new FileCredentialValidator({
        logger: recordingLogger.logger,
      }).validate(config),
    ).rejects.toBeInstanceOf(StorageStateNotFoundError);
    expect(recordingLogger.serialized()).not.toContain(ACCESS_TOKEN);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-startup-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function startupConfigSource(): string {
  return `channels:
  - first_channel
  - second_channel
check_interval_seconds: 60
max_concurrent_streams: 2
storage_state_path: \${TEST_STORAGE_STATE_PATH}
twitch_api:
  client_id: file-client-id
  access_token: file-access-token
`;
}
