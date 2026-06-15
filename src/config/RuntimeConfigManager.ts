import { readFile, writeFile } from 'node:fs/promises';

import { isMap, parseDocument } from 'yaml';

import type { AppConfig } from './AppConfig.js';
import { ConfigParseError, ConfigValidationError } from './errors.js';

const CHANNEL_PATTERN = /^[A-Za-z0-9_]{1,25}$/u;

export interface RuntimeWatchConfig {
  readonly channels: readonly string[];
  readonly maxConcurrentStreams: number;
}

export interface RuntimeWatchConfigTarget {
  updateConfig(config: RuntimeWatchConfig): Promise<void>;
}

export interface RuntimeConfigManager {
  getConfig(): RuntimeWatchConfig;
  setChannels(channels: readonly string[]): Promise<RuntimeWatchConfig>;
  setMaxConcurrentStreams(value: number): Promise<RuntimeWatchConfig>;
}

export interface YamlRuntimeConfigManagerOptions {
  readonly configPath: string;
  readonly initialConfig: Pick<
    AppConfig,
    'channels' | 'maxConcurrentStreams'
  >;
  readonly target: RuntimeWatchConfigTarget;
  readonly readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  readonly writeFile?: (
    path: string,
    data: string,
    encoding: BufferEncoding,
  ) => Promise<void>;
}

export class YamlRuntimeConfigManager implements RuntimeConfigManager {
  private current: RuntimeWatchConfig;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly read: (
    path: string,
    encoding: BufferEncoding,
  ) => Promise<string>;
  private readonly write: (
    path: string,
    data: string,
    encoding: BufferEncoding,
  ) => Promise<void>;

  public constructor(private readonly options: YamlRuntimeConfigManagerOptions) {
    this.current = freezeConfig({
      channels: [...options.initialConfig.channels],
      maxConcurrentStreams: options.initialConfig.maxConcurrentStreams,
    });
    this.read = options.readFile ?? readFile;
    this.write = options.writeFile ?? writeFile;
  }

  public getConfig(): RuntimeWatchConfig {
    return this.current;
  }

  public setChannels(
    channels: readonly string[],
  ): Promise<RuntimeWatchConfig> {
    return this.runExclusive(async () => {
      const validatedChannels = validateChannels(channels);
      const next = freezeConfig({
        channels: validatedChannels,
        maxConcurrentStreams: Math.min(
          this.current.maxConcurrentStreams,
          validatedChannels.length,
        ),
      });
      await this.persist(next);
      this.current = next;
      await this.options.target.updateConfig(next);
      return next;
    });
  }

  public setMaxConcurrentStreams(
    value: number,
  ): Promise<RuntimeWatchConfig> {
    return this.runExclusive(async () => {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new ConfigValidationError(
          'max_concurrent_streams',
          '必須是大於或等於 1 的整數',
        );
      }
      if (value > this.current.channels.length) {
        throw new ConfigValidationError(
          'max_concurrent_streams',
          `不可大於目前頻道數 ${this.current.channels.length}`,
        );
      }

      const next = freezeConfig({
        channels: [...this.current.channels],
        maxConcurrentStreams: value,
      });
      await this.persist(next);
      this.current = next;
      await this.options.target.updateConfig(next);
      return next;
    });
  }

  private async persist(config: RuntimeWatchConfig): Promise<void> {
    const source = await this.read(this.options.configPath, 'utf8');
    const document = parseDocument(source, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new ConfigParseError('無法更新含有語法錯誤的設定檔');
    }
    if (!isMap(document.contents)) {
      throw new ConfigParseError('設定檔根節點必須是物件');
    }

    document.set('channels', [...config.channels]);
    document.set(
      'max_concurrent_streams',
      config.maxConcurrentStreams,
    );
    await this.write(this.options.configPath, String(document), 'utf8');
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function validateChannels(channels: readonly string[]): readonly string[] {
  if (channels.length === 0) {
    throw new ConfigValidationError('channels', '至少需要一個頻道');
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, channel] of channels.entries()) {
    const normalized = channel.trim();
    if (!CHANNEL_PATTERN.test(normalized)) {
      throw new ConfigValidationError(
        `channels[${index}]`,
        '必須是 1 到 25 字元的英數字或底線',
      );
    }
    const key = normalized.toLocaleLowerCase('en-US');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function freezeConfig(config: RuntimeWatchConfig): RuntimeWatchConfig {
  return Object.freeze({
    channels: Object.freeze([...config.channels]),
    maxConcurrentStreams: config.maxConcurrentStreams,
  });
}
