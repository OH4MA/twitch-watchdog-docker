import type {
  AppConfig,
  BrowserConfig,
  LogLevel,
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
      ...overrides.twitchApi,
    },
    browser: {
      navigationTimeoutMs: 30_000,
      pageHealthCheckIntervalSeconds: 30,
      rewardCheckIntervalSeconds: 15,
      restartOnCrash: true,
      ...overrides.browser,
    },
  };
}
