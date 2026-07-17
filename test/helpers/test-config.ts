import type {
  AppConfig,
  BrowserConfig,
  DiscordConfig,
  LogLevel,
  ResourceGuardConfig,
  TelegramConfig,
  TwitchApiConfig,
} from '../../src/config/index.js';
import { computeEffectiveResourceGuardThresholds } from '../../src/config/resourceGuardThresholds.js';

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

export function createDefaultResourceGuard(
  maxConcurrentStreams = 2,
  overrides: Partial<ResourceGuardConfig> = {},
): ResourceGuardConfig {
  const anchors = {
    scaleWithStreams: overrides.scaleWithStreams ?? true,
    baselineStreams: overrides.baselineStreams ?? 3,
    baseMemoryMib: overrides.baseMemoryMib ?? 512,
    warningMemoryMib: overrides.warningMemoryMib ?? 4_096,
    warningResetMemoryMib: overrides.warningResetMemoryMib ?? 3_840,
    browserRecycleMemoryMib: overrides.browserRecycleMemoryMib ?? 4_608,
    emergencyMemoryMib: overrides.emergencyMemoryMib ?? 5_376,
    postRecycleTargetMemoryMib:
      overrides.postRecycleTargetMemoryMib ?? 4_096,
  };

  return {
    enabled: overrides.enabled ?? true,
    sampleIntervalSeconds: overrides.sampleIntervalSeconds ?? 2,
    startupRateGraceSeconds: overrides.startupRateGraceSeconds ?? 120,
    scaleWithStreams: anchors.scaleWithStreams,
    baselineStreams: anchors.baselineStreams,
    baseMemoryMib: anchors.baseMemoryMib,
    warningMemoryMib: anchors.warningMemoryMib,
    warningResetMemoryMib: anchors.warningResetMemoryMib,
    browserRecycleMemoryMib: anchors.browserRecycleMemoryMib,
    browserRecycleConsecutiveSamples:
      overrides.browserRecycleConsecutiveSamples ?? 2,
    emergencyMemoryMib: anchors.emergencyMemoryMib,
    emergencySwapMib: overrides.emergencySwapMib ?? 768,
    fastGrowthMib: overrides.fastGrowthMib ?? 512,
    fastGrowthWindowSeconds: overrides.fastGrowthWindowSeconds ?? 10,
    postRecycleObservationSeconds:
      overrides.postRecycleObservationSeconds ?? 20,
    postRecycleTargetMemoryMib: anchors.postRecycleTargetMemoryMib,
    postRecycleMinimumDropMib: overrides.postRecycleMinimumDropMib ?? 512,
    effective:
      overrides.effective ??
      computeEffectiveResourceGuardThresholds(anchors, maxConcurrentStreams),
  };
}

export function createTestConfig(
  overrides: TestConfigOverrides = {},
): AppConfig {
  const maxConcurrentStreams = overrides.maxConcurrentStreams ?? 2;
  return {
    channels: overrides.channels ?? ['first_channel', 'second_channel'],
    checkIntervalSeconds: overrides.checkIntervalSeconds ?? 60,
    maxConcurrentStreams,
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
      resourceGuard: createDefaultResourceGuard(maxConcurrentStreams),
      ...overrides.browser,
      resourceGuard:
        overrides.browser?.resourceGuard ??
        createDefaultResourceGuard(maxConcurrentStreams),
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
