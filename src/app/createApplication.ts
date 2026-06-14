import {
  DefaultBrowserManager,
  DefaultChannelSessionFactory,
  RewardClaimer,
} from '../browser/index.js';
import {
  DEFAULT_CONFIG_PATH,
  YamlConfigLoader,
  type AppConfig,
  type ConfigLoader,
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
import { TwitchApiClient } from '../twitch/index.js';
import {
  DefaultAppRunner,
  type AppRunner,
  type ApplicationLoggerFactory,
  type ApplicationRuntime,
  type RuntimeFactory,
} from './AppRunner.js';

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
  const bootstrapLogger =
    options.bootstrapLogger ?? createLogger({ level: 'info' });

  return new DefaultAppRunner({
    configPath:
      options.configPath ?? env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
    env,
    configLoader:
      options.configLoader ?? new YamlConfigLoader(bootstrapLogger),
    credentialValidator:
      options.credentialValidator ?? new FileCredentialValidator(),
    bootstrapLogger,
    loggerFactory:
      options.loggerFactory ??
      ((config) => createLogger({ level: config.logLevel })),
    runtimeFactory: options.runtimeFactory ?? createDefaultRuntime,
  });
}

export function createDefaultRuntime(
  config: AppConfig,
  logger: Logger,
): ApplicationRuntime {
  const sessionManagerReference: {
    current?: DefaultSessionManager;
  } = {};

  const browserManager = new DefaultBrowserManager(config, {
    logger,
    onInvalidated: (invalidation) =>
      sessionManagerReference.current?.invalidate(
        invalidation.channel,
        invalidation.reason,
      ),
  });
  const rewardClaimer = new RewardClaimer({ logger });
  const sessionFactory = new DefaultChannelSessionFactory({
    config,
    browserManager,
    rewardClaimer,
    logger,
    onInvalidated: (channel, reason) =>
      sessionManagerReference.current?.invalidate(channel, reason),
  });

  const sessionManager = new DefaultSessionManager(sessionFactory, {
    logger,
  });
  sessionManagerReference.current = sessionManager;

  const liveStatusProvider = new TwitchApiClient({
    clientId: config.twitchApi.clientId,
    accessToken: config.twitchApi.accessToken,
    checkIntervalSeconds: config.checkIntervalSeconds,
    logger,
  });
  const scheduler = new DefaultWatchdogScheduler({
    config,
    liveStatusProvider,
    streamSelector: { selectActiveChannels },
    sessionManager,
    logger,
  });

  return {
    browserManager,
    sessionManager,
    scheduler,
  };
}
