import { readFile } from 'node:fs/promises';

import {
  LOG_LEVELS,
  STREAM_QUALITIES,
  type AppConfig,
  type BrowserConfig,
  type LogLevel,
  type StreamQuality,
  type TelegramConfig,
  type TwitchApiConfig,
} from './AppConfig.js';
import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
} from './errors.js';
import { parseYaml } from './yaml.js';

const DEFAULT_CONFIG_PATH = '/app/config.yml';
const DEFAULT_CHECK_INTERVAL_SECONDS = 60;
const DEFAULT_MAX_CONCURRENT_STREAMS = 3;
const DEFAULT_STORAGE_STATE_PATH =
  '/data/browser-state/storage-state.json';
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_HEALTH_CHECK_INTERVAL_SECONDS = 60;
const DEFAULT_REWARD_CHECK_INTERVAL_SECONDS = 30;
const DEFAULT_STREAM_QUALITY: StreamQuality = '160p';
const DEFAULT_ENFORCE_STREAM_QUALITY_SECONDS = 120;
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 720;
const DEFAULT_RESOURCE_TELEMETRY_INTERVAL_SECONDS = 300;
const MINIMUM_VIEWPORT_WIDTH = 320;
const MINIMUM_VIEWPORT_HEIGHT = 180;
const DEFAULT_TELEGRAM_POLLING_TIMEOUT_SECONDS = 25;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_TIMER_DELAY_SECONDS = Math.floor(MAX_TIMER_DELAY_MS / 1_000);
const CHANNEL_PATTERN = /^[A-Za-z0-9_]{1,25}$/u;
const ENV_REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/u;

type UnknownRecord = Record<string, unknown>;

export interface ConfigLogger {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface ConfigLoader {
  load(path: string, env: NodeJS.ProcessEnv): Promise<AppConfig>;
}

const NOOP_LOGGER: ConfigLogger = {
  debug: () => undefined,
};

export class YamlConfigLoader implements ConfigLoader {
  constructor(private readonly logger: ConfigLogger = NOOP_LOGGER) {}

  async load(path: string, env: NodeJS.ProcessEnv): Promise<AppConfig> {
    const configPath = (env.CONFIG_PATH ?? path) || DEFAULT_CONFIG_PATH;
    const source = await readConfigFile(configPath);
    const parsed = parseYaml(source);
    const interpolated = interpolateEnvironment(parsed, env);
    const root = requireRecord(interpolated, 'root');
    const config = buildConfig(root, env, this.logger);

    return deepFreeze(config);
  }
}

async function readConfigFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new ConfigFileNotFoundError(path);
    }
    throw new ConfigParseError(`無法讀取設定檔 ${path}`);
  }
}

function buildConfig(
  root: UnknownRecord,
  env: NodeJS.ProcessEnv,
  logger: ConfigLogger,
): AppConfig {
  const channels = requireChannels(root.channels);
  const requestedMaxConcurrentStreams = optionalPositiveInteger(
    root.max_concurrent_streams,
    'max_concurrent_streams',
    DEFAULT_MAX_CONCURRENT_STREAMS,
  );
  const maxConcurrentStreams = Math.min(
    requestedMaxConcurrentStreams,
    channels.length,
  );

  if (requestedMaxConcurrentStreams > channels.length) {
    logger.debug('config_concurrency_clamped', {
      requestedMaxConcurrentStreams,
      effectiveMaxConcurrentStreams: maxConcurrentStreams,
      channelCount: channels.length,
    });
  }

  const config: AppConfig = {
    channels,
    checkIntervalSeconds: optionalIntegerAtLeast(
      root.check_interval_seconds,
      'check_interval_seconds',
      DEFAULT_CHECK_INTERVAL_SECONDS,
      30,
      MAX_TIMER_DELAY_SECONDS,
    ),
    maxConcurrentStreams,
    headless: resolveBooleanOverride(
      env.HEADLESS,
      root.headless,
      'headless',
      true,
    ),
    storageStatePath: optionalNonEmptyString(
      root.storage_state_path,
      'storage_state_path',
      DEFAULT_STORAGE_STATE_PATH,
    ),
    logLevel: resolveLogLevel(env.LOG_LEVEL, root.log_level),
    twitchApi: buildTwitchApi(root.twitch_api, env),
    browser: buildBrowserConfig(root.browser),
    telegram: buildTelegramConfig(root.telegram, env),
  };

  return config;
}

function buildTelegramConfig(
  value: unknown,
  env: NodeJS.ProcessEnv,
): TelegramConfig {
  const telegram = value === undefined
    ? {}
    : requireRecord(value, 'telegram');
  const enabled = resolveBooleanOverride(
    env.TELEGRAM_ENABLED,
    telegram.enabled,
    'telegram.enabled',
    false,
  );
  const botToken = resolveOptionalStringOverride(
    env.TELEGRAM_BOT_TOKEN,
    telegram.bot_token,
    'telegram.bot_token',
  );
  const allowedChatIds = resolveTelegramChatIds(
    env.TELEGRAM_ALLOWED_CHAT_IDS,
    telegram.allowed_chat_ids,
  );

  if (enabled && botToken === '') {
    throw new ConfigValidationError(
      'telegram.bot_token',
      '啟用 Telegram 時必須是非空字串',
    );
  }
  if (enabled && allowedChatIds.length === 0) {
    throw new ConfigValidationError(
      'telegram.allowed_chat_ids',
      '啟用 Telegram 時至少需要一個 chat ID',
    );
  }

  return {
    enabled,
    botToken,
    allowedChatIds,
    pollingTimeoutSeconds: optionalIntegerAtLeast(
      telegram.polling_timeout_seconds,
      'telegram.polling_timeout_seconds',
      DEFAULT_TELEGRAM_POLLING_TIMEOUT_SECONDS,
      1,
      50,
    ),
  };
}

function resolveOptionalStringOverride(
  environmentValue: string | undefined,
  configValue: unknown,
  field: string,
): string {
  const value = environmentValue ?? configValue;
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string' && value.trim() === '') {
    return '';
  }
  return requireNonEmptyString(value, field);
}

function resolveTelegramChatIds(
  environmentValue: string | undefined,
  configValue: unknown,
): readonly string[] {
  const values = environmentValue === undefined
    ? configValue
    : environmentValue.trim() === ''
      ? []
      : environmentValue.split(',').map((item) => item.trim());

  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new ConfigValidationError(
      'telegram.allowed_chat_ids',
      '必須是 chat ID 字串陣列',
    );
  }

  return [...new Set(values.map((value, index) => {
    if (
      typeof value !== 'string' ||
      !TELEGRAM_CHAT_ID_PATTERN.test(value)
    ) {
      throw new ConfigValidationError(
        `telegram.allowed_chat_ids[${index}]`,
        '必須是整數格式的 chat ID 字串',
      );
    }
    return value;
  }))];
}

function buildTwitchApi(
  value: unknown,
  env: NodeJS.ProcessEnv,
): TwitchApiConfig {
  const twitchApi = value === undefined
    ? {}
    : requireRecord(value, 'twitch_api');
  const accessToken = resolveOptionalStringOverride(
    env.TWITCH_ACCESS_TOKEN,
    twitchApi.access_token,
    'twitch_api.access_token',
  );
  const clientSecret = resolveOptionalStringOverride(
    env.TWITCH_CLIENT_SECRET,
    twitchApi.client_secret,
    'twitch_api.client_secret',
  );

  if (accessToken === '' && clientSecret === '') {
    throw new ConfigValidationError(
      'twitch_api',
      'access_token 與 client_secret 至少需要一個',
    );
  }

  return {
    clientId: requireNonEmptyString(
      env.TWITCH_CLIENT_ID ?? twitchApi.client_id,
      'twitch_api.client_id',
    ),
    accessToken,
    clientSecret,
  };
}

function buildBrowserConfig(value: unknown): BrowserConfig {
  const browser = value === undefined ? {} : requireRecord(value, 'browser');

  return {
    navigationTimeoutMs: optionalPositiveInteger(
      browser.navigation_timeout_ms,
      'browser.navigation_timeout_ms',
      DEFAULT_NAVIGATION_TIMEOUT_MS,
      MAX_TIMER_DELAY_MS,
    ),
    pageHealthCheckIntervalSeconds: optionalPositiveInteger(
      browser.page_health_check_interval_seconds,
      'browser.page_health_check_interval_seconds',
      DEFAULT_PAGE_HEALTH_CHECK_INTERVAL_SECONDS,
      MAX_TIMER_DELAY_SECONDS,
    ),
    rewardCheckIntervalSeconds: optionalPositiveInteger(
      browser.reward_check_interval_seconds,
      'browser.reward_check_interval_seconds',
      DEFAULT_REWARD_CHECK_INTERVAL_SECONDS,
      MAX_TIMER_DELAY_SECONDS,
    ),
    restartOnCrash: optionalBoolean(
      browser.restart_on_crash,
      'browser.restart_on_crash',
      true,
    ),
    streamQuality: optionalStreamQuality(browser.stream_quality),
    enforceStreamQualitySeconds: optionalPositiveInteger(
      browser.enforce_stream_quality_seconds,
      'browser.enforce_stream_quality_seconds',
      DEFAULT_ENFORCE_STREAM_QUALITY_SECONDS,
      MAX_TIMER_DELAY_SECONDS,
    ),
    viewportWidth: optionalIntegerAtLeast(
      browser.viewport_width,
      'browser.viewport_width',
      DEFAULT_VIEWPORT_WIDTH,
      MINIMUM_VIEWPORT_WIDTH,
      3_840,
    ),
    viewportHeight: optionalIntegerAtLeast(
      browser.viewport_height,
      'browser.viewport_height',
      DEFAULT_VIEWPORT_HEIGHT,
      MINIMUM_VIEWPORT_HEIGHT,
      2_160,
    ),
    muteAudio: optionalBoolean(
      browser.mute_audio,
      'browser.mute_audio',
      true,
    ),
    blockImages: optionalBoolean(
      browser.block_images,
      'browser.block_images',
      false,
    ),
    blockFonts: optionalBoolean(
      browser.block_fonts,
      'browser.block_fonts',
      false,
    ),
    blockKnownTracking: optionalBoolean(
      browser.block_known_tracking,
      'browser.block_known_tracking',
      false,
    ),
    resourceTelemetryIntervalSeconds: optionalPositiveInteger(
      browser.resource_telemetry_interval_seconds,
      'browser.resource_telemetry_interval_seconds',
      DEFAULT_RESOURCE_TELEMETRY_INTERVAL_SECONDS,
      MAX_TIMER_DELAY_SECONDS,
    ),
  };
}

function optionalStreamQuality(value: unknown): StreamQuality {
  if (value === undefined) {
    return DEFAULT_STREAM_QUALITY;
  }
  if (
    typeof value !== 'string' ||
    !STREAM_QUALITIES.includes(value as StreamQuality)
  ) {
    throw new ConfigValidationError(
      'browser.stream_quality',
      `必須是 ${STREAM_QUALITIES.join('、')} 其中之一`,
    );
  }
  return value as StreamQuality;
}

function requireChannels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigValidationError('channels', '必須是非空陣列');
  }

  return value.map((channel, index) => {
    if (typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel)) {
      throw new ConfigValidationError(
        `channels[${index}]`,
        '必須是 1 到 25 字元的英數字或底線',
      );
    }
    return channel;
  });
}

function optionalIntegerAtLeast(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) {
    return fallback;
  }
  const numberValue = requireInteger(value, field);
  if (numberValue < minimum) {
    throw new ConfigValidationError(field, `必須大於或等於 ${minimum}`);
  }
  if (numberValue > maximum) {
    throw new ConfigValidationError(field, `必須小於或等於 ${maximum}`);
  }
  return numberValue;
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
  fallback: number,
  maximum?: number,
): number {
  return optionalIntegerAtLeast(value, field, fallback, 1, maximum);
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ConfigValidationError(field, '必須是整數');
  }
  return value;
}

function resolveBooleanOverride(
  environmentValue: string | undefined,
  configValue: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (environmentValue !== undefined) {
    return parseEnvironmentBoolean(environmentValue, field);
  }
  return optionalBoolean(configValue, field, fallback);
}

function parseEnvironmentBoolean(value: string, field: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new ConfigValidationError(
    field,
    '環境變數必須是 true 或 false',
  );
}

function optionalBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigValidationError(field, '必須是布林值');
  }
  return value;
}

function resolveLogLevel(
  environmentValue: string | undefined,
  configValue: unknown,
): LogLevel {
  const value = environmentValue ?? configValue ?? 'info';
  if (
    typeof value !== 'string' ||
    !LOG_LEVELS.includes(value as LogLevel)
  ) {
    throw new ConfigValidationError(
      'log_level',
      `必須是 ${LOG_LEVELS.join('、')} 其中之一`,
    );
  }
  return value as LogLevel;
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
  fallback: string,
): string {
  return value === undefined
    ? fallback
    : requireNonEmptyString(value, field);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigValidationError(field, '必須是非空字串');
  }
  return value;
}

function requireRecord(value: unknown, field: string): UnknownRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new ConfigValidationError(field, '必須是物件');
  }
  return value as UnknownRecord;
}

function interpolateEnvironment(
  value: unknown,
  env: NodeJS.ProcessEnv,
): unknown {
  if (typeof value === 'string') {
    return value.replace(
      ENV_REFERENCE_PATTERN,
      (_match, variableName: string) => env[variableName] ?? '',
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnvironment(item, env));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        interpolateEnvironment(item, env),
      ]),
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.isFrozen(value)
  ) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export { DEFAULT_CONFIG_PATH };
export type {
  AppConfig,
  BrowserConfig,
  LogLevel,
  TelegramConfig,
  TwitchApiConfig,
} from './AppConfig.js';
export {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
} from './errors.js';
