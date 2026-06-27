export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export const STREAM_QUALITIES = ['auto', '160p', '360p', '480p'] as const;
export type StreamQuality = (typeof STREAM_QUALITIES)[number];

export interface TwitchApiConfig {
  readonly clientId: string;
  readonly accessToken: string;
  readonly clientSecret: string;
}

export interface BrowserConfig {
  readonly navigationTimeoutMs: number;
  readonly pageHealthCheckIntervalSeconds: number;
  readonly rewardCheckIntervalSeconds: number;
  readonly pageRefreshIntervalSeconds: number;
  readonly restartOnCrash: boolean;
  readonly streamQuality: StreamQuality;
  readonly enforceStreamQualitySeconds: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly muteAudio: boolean;
  readonly blockImages: boolean;
  readonly blockFonts: boolean;
  readonly blockKnownTracking: boolean;
  readonly resourceTelemetryIntervalSeconds: number;
}

export interface TelegramConfig {
  readonly enabled: boolean;
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly pollingTimeoutSeconds: number;
}

export interface DiscordConfig {
  readonly enabled: boolean;
  readonly botToken: string;
  readonly applicationId: string;
  readonly guildId: string;
  readonly allowedChannelIds: readonly string[];
  readonly allowDirectMessages: boolean;
  readonly allowedUserIds: readonly string[];
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
  readonly discord: DiscordConfig;
}
