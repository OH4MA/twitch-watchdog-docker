import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigValidationError,
  YamlRuntimeConfigManager,
} from '../../src/config/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('YamlRuntimeConfigManager', () => {
  it('更新 channels 並保留其他 YAML 設定與註解', async () => {
    const path = await createConfig(`
# keep this comment
channels:
  - first
  - second
max_concurrent_streams: 2
log_level: debug
twitch_api:
  client_id: \${TWITCH_CLIENT_ID}
`);
    const updateConfig = vi.fn(async () => undefined);
    const manager = new YamlRuntimeConfigManager({
      configPath: path,
      initialConfig: {
        channels: ['first', 'second'],
        maxConcurrentStreams: 2,
      },
      target: { updateConfig },
    });

    const result = await manager.setChannels(['second', 'third']);
    const source = await readFile(path, 'utf8');

    expect(result).toEqual({
      channels: ['second', 'third'],
      maxConcurrentStreams: 2,
    });
    expect(updateConfig).toHaveBeenCalledWith(result);
    expect(source).toContain('# keep this comment');
    expect(source).toContain('log_level: debug');
    expect(source).toContain('client_id: ${TWITCH_CLIENT_ID}');
    expect(source).toContain('  - second');
    expect(source).toContain('  - third');
  });

  it('頻道減少時自動降低最大同時觀看', async () => {
    const path = await createConfig(`
channels: [first, second]
max_concurrent_streams: 2
`);
    const manager = new YamlRuntimeConfigManager({
      configPath: path,
      initialConfig: {
        channels: ['first', 'second'],
        maxConcurrentStreams: 2,
      },
      target: { updateConfig: vi.fn(async () => undefined) },
    });

    await expect(manager.setChannels(['first'])).resolves.toEqual({
      channels: ['first'],
      maxConcurrentStreams: 1,
    });
    expect(await readFile(path, 'utf8')).toContain(
      'max_concurrent_streams: 1',
    );
  });

  it('拒絕空頻道、非法名稱與超過頻道數的上限', async () => {
    const path = await createConfig('channels: [first]\n');
    const manager = new YamlRuntimeConfigManager({
      configPath: path,
      initialConfig: {
        channels: ['first'],
        maxConcurrentStreams: 1,
      },
      target: { updateConfig: vi.fn(async () => undefined) },
    });

    await expect(manager.setChannels([])).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
    await expect(manager.setChannels(['bad-name'])).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
    await expect(
      manager.setMaxConcurrentStreams(2),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('大小寫不敏感去除重複頻道', async () => {
    const path = await createConfig('channels: [first]\n');
    const manager = new YamlRuntimeConfigManager({
      configPath: path,
      initialConfig: {
        channels: ['first'],
        maxConcurrentStreams: 1,
      },
      target: { updateConfig: vi.fn(async () => undefined) },
    });

    await expect(
      manager.setChannels(['First', 'first', 'Second']),
    ).resolves.toEqual({
      channels: ['First', 'Second'],
      maxConcurrentStreams: 1,
    });
  });
});

async function createConfig(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-config-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'config.yml');
  await writeFile(path, source, 'utf8');
  return path;
}
