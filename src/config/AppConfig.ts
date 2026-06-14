export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface TwitchApiConfig {
  readonly clientId: string;
  readonly accessToken: string;
}

export interface BrowserConfig {
  readonly navigationTimeoutMs: number;
  readonly pageHealthCheckIntervalSeconds: number;
  readonly rewardCheckIntervalSeconds: number;
  readonly restartOnCrash: boolean;
}

export interface TelegramConfig {
  readonly enabled: boolean;
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly pollingTimeoutSeconds: number;
}

export interface AppConfig {
  readonly channels: readonly string[];
  readonly checkIntervalSeconds: number;
  readonly maxConcurrentStreams: number;
  readonly headless: boolean;
  readonly storageStatePath: string;
  readonly logLevel: LogLevel;
  readonly twitchApi: TwitchApiConfig;
  readonly browser: BrowserConfig;
  readonly telegram: TelegramConfig;
}
