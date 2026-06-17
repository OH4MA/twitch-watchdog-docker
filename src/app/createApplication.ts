import {
  DefaultBrowserManager,
  DefaultChannelSessionFactory,
  RewardClaimer,
} from '../browser/index.js';
import {
  DEFAULT_CONFIG_PATH,
  YamlRuntimeConfigManager,
  YamlConfigLoader,
  type AppConfig,
  type ConfigLoader,
  type RuntimeWatchConfig,
} from '../config/index.js';
import {
  FileCredentialValidator,
  type CredentialValidator,
} from '../credentials/index.js';
import {
  createLogger,
  type Logger,
} from '../logging/index.js';
import {
  DefaultWatchdogScheduler,
  selectActiveChannels,
} from '../scheduler/index.js';
import { DefaultSessionManager } from '../sessions/index.js';
import {
  DefaultTelegramBot,
  TelegramApiClient,
  type TelegramBot,
} from '../telegram/index.js';
import { TwitchApiClient } from '../twitch/index.js';
import {
  DefaultAppRunner,
  type AppRunner,
  type ApplicationLoggerFactory,
  type ApplicationRuntime,
  type RuntimeFactory,
} from './AppRunner.js';
import { RuntimeResourceMonitor } from './RuntimeResourceMonitor.js';

export interface CreateApplicationOptions {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly bootstrapLogger?: Logger;
  readonly configLoader?: ConfigLoader;
  readonly credentialValidator?: CredentialValidator;
  readonly loggerFactory?: ApplicationLoggerFactory;
  readonly runtimeFactory?: RuntimeFactory;
}

export function createApplication(
  options: CreateApplicationOptions = {},
): AppRunner {
  const env = options.env ?? process.env;
  const configPath =
    options.configPath ?? env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  const bootstrapLogger =
    options.bootstrapLogger ?? createLogger({ level: 'info' });

  return new DefaultAppRunner({
    configPath,
    env,
    configLoader:
      options.configLoader ?? new YamlConfigLoader(bootstrapLogger),
    credentialValidator:
      options.credentialValidator ?? new FileCredentialValidator(),
    bootstrapLogger,
    loggerFactory:
      options.loggerFactory ??
      ((config) => createLogger({ level: config.logLevel })),
    runtimeFactory:
      options.runtimeFactory ??
      ((config, logger) =>
        createDefaultRuntime(config, logger, configPath)),
  });
}

export function createDefaultRuntime(
  config: AppConfig,
  logger: Logger,
  configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): ApplicationRuntime {
  const sessionManagerReference: {
    current?: DefaultSessionManager;
  } = {};
  let runtimeWatchConfig: RuntimeWatchConfig = {
    channels: config.channels,
    maxConcurrentStreams: config.maxConcurrentStreams,
  };
  let telegramBot: TelegramBot | undefined;

  const browserManager = new DefaultBrowserManager(config, {
    logger,
    onInvalidated: (invalidation) =>
      sessionManagerReference.current?.invalidate(
        invalidation.channel,
        invalidation.reason,
      ),
  });
  const rewardClaimer = new RewardClaimer({
    logger,
    onResult: (result) => telegramBot?.notifyReward(result),
  });
  const sessionFactory = new DefaultChannelSessionFactory({
    config: {
      get channels() {
        return runtimeWatchConfig.channels;
      },
      browser: config.browser,
    },
    browserManager,
    rewardClaimer,
    logger,
    onInvalidated: (channel, reason) =>
      sessionManagerReference.current?.invalidate(channel, reason),
    onPageRefresh: (event) => telegramBot?.notifyPageRefresh(event),
  });

  const sessionManager = new DefaultSessionManager(sessionFactory, {
    logger,
  });
  sessionManagerReference.current = sessionManager;

  const liveStatusProvider = new TwitchApiClient({
    clientId: config.twitchApi.clientId,
    accessToken: config.twitchApi.accessToken,
    clientSecret: config.twitchApi.clientSecret,
    checkIntervalSeconds: config.checkIntervalSeconds,
    logger,
  });
  const scheduler = new DefaultWatchdogScheduler({
    config,
    liveStatusProvider,
    streamSelector: { selectActiveChannels },
    sessionManager,
    logger,
    onStreamStatusChanged: (change) =>
      telegramBot?.notifyStreamStatus(change),
  });
  const runtimeConfigManager = new YamlRuntimeConfigManager({
    configPath,
    initialConfig: config,
    target: {
      async updateConfig(nextConfig) {
        runtimeWatchConfig = nextConfig;
        await scheduler.updateConfig(nextConfig);
      },
    },
  });
  const integrations = [
    new RuntimeResourceMonitor({
      browserManager,
      sessionManager,
      logger,
      intervalSeconds:
        config.browser.resourceTelemetryIntervalSeconds,
    }),
    ...(config.telegram.enabled
      ? [
        (telegramBot = new DefaultTelegramBot({
          config,
          api: new TelegramApiClient({
            botToken: config.telegram.botToken,
          }),
          scheduler,
          sessionManager,
          runtimeConfigManager,
          logger,
        })),
      ]
      : []),
  ];

  return {
    browserManager,
    sessionManager,
    scheduler,
    integrations,
  };
}
