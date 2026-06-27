import type {
  AppConfig,
  BrowserConfig,
  DiscordConfig,
  LogLevel,
  TelegramConfig,
  TwitchApiConfig,
} from '../../src/config/index.js';

export interface TestConfigOverrides {
  readonly channels?: readonly string[];
  readonly checkIntervalSeconds?: number;
  readonly maxConcurrentStreams?: number;
  readonly headless?: boolean;
  readonly storageStatePath?: string;
  readonly logLevel?: LogLevel;
  readonly twitchApi?: Partial<TwitchApiConfig>;
  readonly browser?: Partial<BrowserConfig>;
  readonly telegram?: Partial<TelegramConfig>;
  readonly discord?: Partial<DiscordConfig>;
}

export function createTestConfig(
  overrides: TestConfigOverrides = {},
): AppConfig {
  return {
    channels: overrides.channels ?? ['first_channel', 'second_channel'],
    checkIntervalSeconds: overrides.checkIntervalSeconds ?? 60,
    maxConcurrentStreams: overrides.maxConcurrentStreams ?? 2,
    headless: overrides.headless ?? true,
    storageStatePath:
      overrides.storageStatePath ?? '/tmp/test-storage-state.json',
    logLevel: overrides.logLevel ?? 'debug',
    twitchApi: {
      clientId: 'integration-client-id',
      accessToken: 'integration-access-token',
      clientSecret: '',
      ...overrides.twitchApi,
    },
    browser: {
      navigationTimeoutMs: 30_000,
      pageHealthCheckIntervalSeconds: 60,
      rewardCheckIntervalSeconds: 30,
      pageRefreshIntervalSeconds: 300,
      restartOnCrash: true,
      streamQuality: '160p',
      enforceStreamQualitySeconds: 120,
      viewportWidth: 1280,
      viewportHeight: 720,
      muteAudio: true,
      blockImages: false,
      blockFonts: false,
      blockKnownTracking: false,
      resourceTelemetryIntervalSeconds: 300,
      ...overrides.browser,
    },
    telegram: {
      enabled: false,
      botToken: '',
      allowedChatIds: [],
      pollingTimeoutSeconds: 25,
      ...overrides.telegram,
    },
    discord: {
      enabled: false,
      botToken: '',
      applicationId: '',
      guildId: '',
      allowedChannelIds: [],
      allowDirectMessages: false,
      allowedUserIds: [],
      ...overrides.discord,
    },
  };
}
