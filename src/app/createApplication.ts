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
  DefaultDiscordBot,
  DiscordApiClient,
  type DiscordBot,
} from '../discord/index.js';
import {
  createLogger,
  type Logger,
} from '../logging/index.js';
import type { BotCommandContext } from '../notifications/BotCommandContext.js';
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
  type ApplicationIntegration,
  type RuntimeFactory,
} from './AppRunner.js';
import { ContainerRestartController } from './ContainerRestartController.js';
import { RuntimeResourceMonitor } from './RuntimeResourceMonitor.js';
import { SchedulerStallWatchdog } from './SchedulerStallWatchdog.js';

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
  let discordBot: DiscordBot | undefined;

  const notify = async (
    operation: (
      integration: TelegramBot | DiscordBot,
    ) => Promise<void>,
  ): Promise<void> => {
    await Promise.all(
      [telegramBot, discordBot]
        .filter((bot): bot is TelegramBot | DiscordBot => bot !== undefined)
        .map((bot) => operation(bot).catch(() => undefined)),
    );
  };

  const containerRestartController = new ContainerRestartController({
    logger,
  });

  const browserManager = new DefaultBrowserManager(config, {
    logger,
    onInvalidated: (invalidation) =>
      sessionManagerReference.current?.invalidate(
        invalidation.channel,
        invalidation.reason,
      ),
    onFatalRecovery: (request) =>
      containerRestartController.request({
        reason: request.reason,
        source: 'browser_manager',
        ...(request.fields === undefined ? {} : { fields: request.fields }),
      }),
  });
  const rewardClaimer = new RewardClaimer({
    logger,
    onResult: (result) => notify((bot) => bot.notifyReward(result)),
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
    onPageRefresh: (event) =>
      notify((bot) => bot.notifyPageRefresh(event)),
    onContainerRestartRequested: (request) =>
      containerRestartController.request({
        reason: request.reason,
        source: 'channel_session_reward',
        fields: {
          channel: request.channel,
          consecutiveFailures: request.consecutiveFailures,
          requestedAt: request.requestedAt,
        },
      }),
  });

  const sessionManager = new DefaultSessionManager(sessionFactory, {
    logger,
    startRetryAttempts: 1,
    startRetryDelayMs: 2_000,
    startStaggerMs: 1_000,
    sessionOperationTimeoutMs: Math.max(
      60_000,
      config.browser.navigationTimeoutMs * 2,
    ),
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
      notify((bot) => bot.notifyStreamStatus(change)),
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
  const commandContext: BotCommandContext = {
    runCheck: () => scheduler.runOnce(),
    pauseChecks: () => scheduler.stop(),
    resumeChecks: () => scheduler.start(),
    getSchedulerSnapshot: () => scheduler.getSnapshot(),
    getActiveChannels: () => sessionManager.getActiveChannels(),
    getRefreshStatuses: () => sessionManager.getRefreshStatuses(),
    refreshPages: (channel) => sessionManager.refreshPages(channel),
    captureScreenshot: (channel) =>
      sessionManager.captureScreenshot(channel),
    getConfig: () => runtimeConfigManager.getConfig(),
    setChannels: (channels) => runtimeConfigManager.setChannels(channels),
    setMaxConcurrentStreams: (value) =>
      runtimeConfigManager.setMaxConcurrentStreams(value),
  };
  const integrations: ApplicationIntegration[] = [
    new RuntimeResourceMonitor({
      browserManager,
      sessionManager,
      logger,
      intervalSeconds:
        config.browser.resourceTelemetryIntervalSeconds,
      resourceGuard: config.browser.resourceGuard,
      onContainerRestartRequested: (request) =>
        containerRestartController.request(request),
    }),
    new SchedulerStallWatchdog({
      scheduler,
      logger,
      intervalSeconds: Math.min(60, config.checkIntervalSeconds),
      stallThresholdMs: Math.max(
        600_000,
        config.checkIntervalSeconds * 5_000,
      ),
      containerRestartController,
    }),
    ...(config.telegram.enabled
      ? [
        (telegramBot = new DefaultTelegramBot({
          config,
          api: new TelegramApiClient({
            botToken: config.telegram.botToken,
          }),
          commandContext,
          logger,
        })),
      ]
      : []),
    ...(config.discord.enabled
      ? [
        (discordBot = new DefaultDiscordBot({
          config,
          api: new DiscordApiClient({
            botToken: config.discord.botToken,
          }),
          commandContext,
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
