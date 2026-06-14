import type { AppConfig } from '../config/index.js';
import type { ConfigLoader } from '../config/index.js';
import type { CredentialValidator } from '../credentials/index.js';
import {
  LOG_EVENTS,
  redactSensitiveString,
  type LogFields,
  type Logger,
} from '../logging/index.js';
import type { BrowserManager } from '../browser/BrowserManager.js';
import type { WatchdogScheduler } from '../scheduler/WatchdogScheduler.js';
import type { SessionManager } from '../sessions/index.js';

export interface AppRunner {
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface ApplicationRuntime {
  readonly browserManager: BrowserManager;
  readonly sessionManager: SessionManager;
  readonly scheduler: WatchdogScheduler;
}

export type RuntimeFactory = (
  config: AppConfig,
  logger: Logger,
) => ApplicationRuntime | Promise<ApplicationRuntime>;

export type ApplicationLoggerFactory = (config: AppConfig) => Logger;

export interface DefaultAppRunnerOptions {
  readonly configPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly configLoader: ConfigLoader;
  readonly credentialValidator: CredentialValidator;
  readonly bootstrapLogger: Logger;
  readonly loggerFactory: ApplicationLoggerFactory;
  readonly runtimeFactory: RuntimeFactory;
}

type StartupPhase =
  | 'config'
  | 'logger'
  | 'credential'
  | 'runtime'
  | 'browser'
  | 'scheduler';

export class DefaultAppRunner implements AppRunner {
  private config: AppConfig | undefined;
  private logger: Logger | undefined;
  private runtime: ApplicationRuntime | undefined;
  private startFlight: Promise<void> | undefined;
  private stopFlight: Promise<void> | undefined;
  private cleanupFlight: Promise<void> | undefined;

  public constructor(private readonly options: DefaultAppRunnerOptions) {}

  public start(): Promise<void> {
    if (this.startFlight !== undefined) {
      return this.startFlight;
    }

    if (this.cleanupFlight !== undefined) {
      return Promise.reject(
        new Error('Application cannot start after cleanup has begun'),
      );
    }

    const flight = this.startApplication();
    this.startFlight = flight;
    return flight;
  }

  public stop(reason: string): Promise<void> {
    if (this.stopFlight !== undefined) {
      return this.stopFlight;
    }

    const flight = this.stopApplication(reason);
    this.stopFlight = flight;
    return flight;
  }

  private async startApplication(): Promise<void> {
    let phase: StartupPhase = 'config';

    try {
      const config = await this.options.configLoader.load(
        this.options.configPath,
        this.options.env,
      );
      this.config = config;

      phase = 'logger';
      const logger = this.options.loggerFactory(config);
      this.logger = logger;
      safeLog(logger, 'info', LOG_EVENTS.CONFIG_LOADED, {
        channelCount: config.channels.length,
        maxConcurrentStreams: config.maxConcurrentStreams,
      });

      phase = 'credential';
      const credentialResult =
        await this.options.credentialValidator.validate(config);
      if (!credentialResult.hasCookies) {
        safeLog(logger, 'warn', 'credential_storage_state_empty_cookies', {
          storageStatePath: credentialResult.storageStatePath,
        });
      }
      safeLog(logger, 'info', LOG_EVENTS.CREDENTIAL_CHECKED, {
        storageStatePath: credentialResult.storageStatePath,
        hasCookies: credentialResult.hasCookies,
        twitchApiConfigured: credentialResult.twitchApiConfigured,
      });

      phase = 'runtime';
      const runtime = await this.options.runtimeFactory(config, logger);
      this.runtime = runtime;

      phase = 'browser';
      await runtime.browserManager.start();

      phase = 'scheduler';
      await runtime.scheduler.start();

      safeLog(logger, 'info', LOG_EVENTS.SERVICE_STARTED, {
        channelCount: config.channels.length,
      });
    } catch (error: unknown) {
      const logger = this.currentLogger();
      safeLog(
        logger,
        'error',
        phase === 'config' ? LOG_EVENTS.CONFIG_ERROR : 'service_start_failed',
        {
          phase,
          error: safeErrorMessage(error, this.config),
        },
      );
      await this.cleanup(`startup_failed:${phase}`);
      throw error;
    }
  }

  private async stopApplication(reason: string): Promise<void> {
    await this.startFlight?.catch(() => undefined);
    await this.cleanup(reason);
  }

  private cleanup(reason: string): Promise<void> {
    if (this.cleanupFlight !== undefined) {
      return this.cleanupFlight;
    }

    const flight = this.performCleanup(reason);
    this.cleanupFlight = flight;
    return flight;
  }

  private async performCleanup(reason: string): Promise<void> {
    const runtime = this.runtime;
    const logger = this.currentLogger();

    if (runtime !== undefined) {
      await cleanupStep(
        logger,
        'scheduler',
        () => runtime.scheduler.stop(),
        this.config,
      );
      await cleanupStep(
        logger,
        'session_manager',
        () => runtime.sessionManager.stopAll(reason),
        this.config,
      );
      await cleanupStep(
        logger,
        'browser',
        () => runtime.browserManager.stop(),
        this.config,
      );
    }

    safeLog(logger, 'info', LOG_EVENTS.SERVICE_STOPPED, { reason });

    try {
      await logger.flush();
    } catch (error: unknown) {
      safeLog(this.options.bootstrapLogger, 'error', 'logger_flush_failed', {
        error: safeErrorMessage(error, this.config),
      });
    }
  }

  private currentLogger(): Logger {
    return this.logger ?? this.options.bootstrapLogger;
  }
}

async function cleanupStep(
  logger: Logger,
  component: string,
  operation: () => Promise<void>,
  config?: AppConfig,
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    safeLog(logger, 'error', 'service_stop_component_failed', {
      component,
      error: safeErrorMessage(error, config),
    });
  }
}

export function safeErrorMessage(
  error: unknown,
  config?: AppConfig,
): string {
  let message = 'Unknown application failure';

  try {
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error !== undefined && error !== null) {
      message = String(error);
    }
  } catch {
    message = 'Unserializable application failure';
  }

  let safeMessage = redactSensitiveString(message);
  if (config === undefined) {
    return safeMessage;
  }

  for (const sensitiveValue of [
    config.twitchApi.accessToken,
    config.twitchApi.clientId,
    config.storageStatePath,
  ]) {
    if (sensitiveValue.length > 0) {
      safeMessage = safeMessage.replaceAll(sensitiveValue, '[REDACTED]');
    }
  }

  return safeMessage;
}

function safeLog(
  logger: Logger,
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: LogFields,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Logging must not interrupt startup or cleanup.
  }
}
