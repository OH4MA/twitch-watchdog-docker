import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  DefaultAppRunner,
  createDefaultRuntime,
  installProcessHandlers,
  type ApplicationRuntime,
  type ProcessHandlerTarget,
} from '../../src/app/index.js';
import { DefaultBrowserManager } from '../../src/browser/index.js';
import type { BrowserManager } from '../../src/browser/BrowserManager.js';
import type {
  AppConfig,
  ConfigLoader,
} from '../../src/config/index.js';
import type {
  CredentialValidationResult,
  CredentialValidator,
} from '../../src/credentials/index.js';
import {
  LOG_EVENTS,
  type Logger,
} from '../../src/logging/index.js';
import { DefaultWatchdogScheduler } from '../../src/scheduler/index.js';
import type { WatchdogScheduler } from '../../src/scheduler/WatchdogScheduler.js';
import {
  DefaultSessionManager,
  type SessionManager,
} from '../../src/sessions/index.js';

const CONFIG_PATH = '/test/config.yml';
const STORAGE_STATE_PATH = '/private/storage-state.json';
const ACCESS_TOKEN = 'highly-sensitive-access-token';

const CONFIG: AppConfig = Object.freeze({
  channels: Object.freeze(['first', 'second']),
  checkIntervalSeconds: 60,
  maxConcurrentStreams: 2,
  headless: true,
  storageStatePath: STORAGE_STATE_PATH,
  logLevel: 'info',
  twitchApi: Object.freeze({
    clientId: 'test-client',
    accessToken: ACCESS_TOKEN,
    clientSecret: '',
  }),
  browser: Object.freeze({
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
  }),
  telegram: Object.freeze({
    enabled: false,
    botToken: '',
    allowedChatIds: Object.freeze([]),
    pollingTimeoutSeconds: 25,
  }),
  discord: Object.freeze({
    enabled: false,
    botToken: '',
    applicationId: '',
    guildId: '',
    allowedChannelIds: Object.freeze([]),
    allowDirectMessages: false,
    allowedUserIds: Object.freeze([]),
  }),
});

const CREDENTIAL_RESULT: CredentialValidationResult = Object.freeze({
  storageStatePath: STORAGE_STATE_PATH,
  hasCookies: true,
  twitchApiConfigured: true,
});

interface HarnessOptions {
  readonly configError?: Error;
  readonly credentialError?: Error;
  readonly browserStartError?: Error;
}

function createHarness(options: HarnessOptions = {}) {
  const lifecycleEvents: string[] = [];
  const env: NodeJS.ProcessEnv = {};
  const bootstrapLogger = createTestLogger(lifecycleEvents, 'bootstrap');
  const logger = createTestLogger(lifecycleEvents, 'configured');

  const configLoader: ConfigLoader & {
    readonly load: ReturnType<typeof vi.fn>;
  } = {
    load: vi.fn(async () => {
      lifecycleEvents.push('config.load');
      if (options.configError !== undefined) {
        throw options.configError;
      }
      return CONFIG;
    }),
  };
  const credentialValidator: CredentialValidator & {
    readonly validate: ReturnType<typeof vi.fn>;
  } = {
    validate: vi.fn(async () => {
      lifecycleEvents.push('credential.validate');
      if (options.credentialError !== undefined) {
        throw options.credentialError;
      }
      return CREDENTIAL_RESULT;
    }),
  };
  const browserManager = createBrowserManager(
    lifecycleEvents,
    options.browserStartError,
  );
  const sessionManager = createSessionManager(lifecycleEvents);
  const scheduler = createScheduler(lifecycleEvents);
  const runtime: ApplicationRuntime = {
    browserManager,
    sessionManager,
    scheduler,
  };
  const loggerFactory = vi.fn(() => {
    lifecycleEvents.push('logger.create');
    return logger;
  });
  const runtimeFactory = vi.fn(async () => {
    lifecycleEvents.push('runtime.create');
    return runtime;
  });
  const app = new DefaultAppRunner({
    configPath: CONFIG_PATH,
    env,
    configLoader,
    credentialValidator,
    bootstrapLogger,
    loggerFactory,
    runtimeFactory,
  });

  return {
    app,
    env,
    lifecycleEvents,
    bootstrapLogger,
    logger,
    configLoader,
    credentialValidator,
    browserManager,
    sessionManager,
    scheduler,
    loggerFactory,
    runtimeFactory,
  };
}

describe('DefaultAppRunner', () => {
  it('依 Config、Logger、Credential、Runtime、Browser、Scheduler 順序啟動', async () => {
    const harness = createHarness();

    await harness.app.start();

    expect(harness.lifecycleEvents).toEqual([
      'config.load',
      'logger.create',
      'credential.validate',
      'runtime.create',
      'browser.start',
      'scheduler.start',
    ]);
    expect(harness.configLoader.load).toHaveBeenCalledWith(
      CONFIG_PATH,
      harness.env,
    );
    expect(harness.logger.info.mock.calls.map(([event]) => event)).toEqual([
      LOG_EVENTS.CONFIG_LOADED,
      LOG_EVENTS.CREDENTIAL_CHECKED,
      LOG_EVENTS.SERVICE_STARTED,
    ]);
  });

  it('設定失敗時不建立 logger、驗證 credential 或 runtime', async () => {
    const harness = createHarness({
      configError: new Error('invalid config'),
    });

    await expect(harness.app.start()).rejects.toThrow('invalid config');

    expect(harness.loggerFactory).not.toHaveBeenCalled();
    expect(harness.credentialValidator.validate).not.toHaveBeenCalled();
    expect(harness.runtimeFactory).not.toHaveBeenCalled();
    expect(harness.bootstrapLogger.error).toHaveBeenCalledWith(
      LOG_EVENTS.CONFIG_ERROR,
      {
        phase: 'config',
        error: 'invalid config',
      },
    );
  });

  it('credential 失敗時不建立或啟動 runtime', async () => {
    const harness = createHarness({
      credentialError: new Error('credential unavailable'),
    });

    await expect(harness.app.start()).rejects.toThrow(
      'credential unavailable',
    );

    expect(harness.runtimeFactory).not.toHaveBeenCalled();
    expect(harness.browserManager.start).not.toHaveBeenCalled();
    expect(harness.scheduler.start).not.toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledWith(
      'service_start_failed',
      {
        phase: 'credential',
        error: 'credential unavailable',
      },
    );
  });

  it('Browser 啟動失敗時清理完整 runtime，且不啟動 Scheduler', async () => {
    const harness = createHarness({
      browserStartError: new Error('browser unavailable'),
    });

    await expect(harness.app.start()).rejects.toThrow(
      'browser unavailable',
    );

    expect(harness.scheduler.start).not.toHaveBeenCalled();
    expect(harness.lifecycleEvents).toEqual([
      'config.load',
      'logger.create',
      'credential.validate',
      'runtime.create',
      'browser.start',
      'scheduler.stop',
      'sessionManager.stopAll:startup_failed:browser',
      'browser.stop',
      'configured.flush',
    ]);
  });

  it('停止順序為 Scheduler、SessionManager、Browser、logger flush', async () => {
    const harness = createHarness();
    await harness.app.start();
    harness.lifecycleEvents.length = 0;

    await harness.app.stop('SIGTERM');

    expect(harness.lifecycleEvents).toEqual([
      'scheduler.stop',
      'sessionManager.stopAll:SIGTERM',
      'browser.stop',
      'configured.flush',
    ]);
  });

  it('整合元件在 Browser 後、Scheduler 前啟動，並於 Browser 後停止', async () => {
    const harness = createHarness();
    const integration = {
      start: vi.fn(async () => {
        harness.lifecycleEvents.push('integration.start');
      }),
      stop: vi.fn(async (reason: string) => {
        harness.lifecycleEvents.push(`integration.stop:${reason}`);
      }),
    };
    harness.runtimeFactory.mockResolvedValue({
      browserManager: harness.browserManager,
      sessionManager: harness.sessionManager,
      scheduler: harness.scheduler,
      integrations: [integration],
    });

    await harness.app.start();
    expect(harness.lifecycleEvents).toContain('integration.start');
    expect(harness.lifecycleEvents.indexOf('browser.start')).toBeLessThan(
      harness.lifecycleEvents.indexOf('integration.start'),
    );
    expect(harness.lifecycleEvents.indexOf('integration.start')).toBeLessThan(
      harness.lifecycleEvents.indexOf('scheduler.start'),
    );

    harness.lifecycleEvents.length = 0;
    await harness.app.stop('SIGTERM');
    expect(harness.lifecycleEvents).toEqual([
      'scheduler.stop',
      'sessionManager.stopAll:SIGTERM',
      'browser.stop',
      'integration.stop:SIGTERM',
      'configured.flush',
    ]);
  });

  it('並發及重複 stop 只釋放一次資源', async () => {
    const harness = createHarness();
    await harness.app.start();

    await Promise.all([
      harness.app.stop('SIGINT'),
      harness.app.stop('SIGTERM'),
      harness.app.stop('duplicate'),
    ]);
    await harness.app.stop('after_complete');

    expect(harness.scheduler.stop).toHaveBeenCalledOnce();
    expect(harness.sessionManager.stopAll).toHaveBeenCalledOnce();
    expect(harness.sessionManager.stopAll).toHaveBeenCalledWith('SIGINT');
    expect(harness.browserManager.stop).toHaveBeenCalledOnce();
    expect(harness.logger.flush).toHaveBeenCalledOnce();
  });

  it('啟動後收到 signal 會觸發優雅停止', async () => {
    const harness = createHarness();
    const target = new FakeProcessTarget();
    const removeHandlers = installProcessHandlers({
      app: harness.app,
      logger: harness.bootstrapLogger,
      target,
    });
    await harness.app.start();
    harness.lifecycleEvents.length = 0;

    target.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(harness.logger.flush).toHaveBeenCalledOnce();
    });
    expect(harness.lifecycleEvents).toEqual([
      'scheduler.stop',
      'sessionManager.stopAll:SIGTERM',
      'browser.stop',
      'configured.flush',
    ]);

    removeHandlers();
    expect(target.listenerCount('SIGTERM')).toBe(0);
  });

  it('啟動錯誤日誌不洩漏 token 或 storageState 路徑', async () => {
    const harness = createHarness({
      credentialError: new Error(
        `Authorization: Bearer ${ACCESS_TOKEN}; access_token=${ACCESS_TOKEN}; path=${STORAGE_STATE_PATH}`,
      ),
    });

    await expect(harness.app.start()).rejects.toThrow(ACCESS_TOKEN);

    const logged = JSON.stringify(harness.logger.error.mock.calls);
    expect(logged).not.toContain(ACCESS_TOKEN);
    expect(logged).not.toContain(STORAGE_STATE_PATH);
    expect(logged).toContain('[REDACTED]');
  });
});

describe('程序處理與預設 composition', () => {
  it('未處理 rejection 設定 exitCode、記錄安全錯誤並停止服務', async () => {
    const target = new FakeProcessTarget();
    const logger = createTestLogger([]);
    const app = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const removeHandlers = installProcessHandlers({
      app,
      logger,
      target,
    });

    target.emit(
      'unhandledRejection',
      new Error(`access_token=${ACCESS_TOKEN}`),
    );

    await vi.waitFor(() => {
      expect(app.stop).toHaveBeenCalledWith('unhandled_rejection');
    });
    expect(target.exitCode).toBe(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      ACCESS_TOKEN,
    );

    removeHandlers();
  });

  it('預設 RuntimeFactory 可完成建構且不會呼叫 Twitch', () => {
    const logger = createTestLogger([]);

    const runtime = createDefaultRuntime(CONFIG, logger);

    expect(runtime.browserManager).toBeInstanceOf(DefaultBrowserManager);
    expect(runtime.sessionManager).toBeInstanceOf(DefaultSessionManager);
    expect(runtime.scheduler).toBeInstanceOf(DefaultWatchdogScheduler);
  });
});

function createTestLogger(
  lifecycleEvents: string[] = [],
  name = 'logger',
) {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => {
      lifecycleEvents.push(`${name}.flush`);
    }),
  } satisfies Logger;
}

function createBrowserManager(
  lifecycleEvents: string[],
  startError?: Error,
): BrowserManager & {
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => {
      lifecycleEvents.push('browser.start');
      if (startError !== undefined) {
        throw startError;
      }
    }),
    stop: vi.fn(async () => {
      lifecycleEvents.push('browser.stop');
    }),
    createPage: vi.fn(async () => ({} as Page)),
    closePage: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    getPageCount: vi.fn(() => 0),
  };
}

function createSessionManager(
  lifecycleEvents: string[],
): SessionManager & {
  readonly stopAll: ReturnType<typeof vi.fn>;
} {
  return {
    reconcile: vi.fn(async () => undefined),
    stopAll: vi.fn(async (reason: string) => {
      lifecycleEvents.push(`sessionManager.stopAll:${reason}`);
    }),
    invalidate: vi.fn(async () => undefined),
    getActiveChannels: vi.fn(() => []),
    getRefreshStatuses: vi.fn(() => []),
    captureScreenshot: vi.fn(async () => undefined),
  };
}

function createScheduler(
  lifecycleEvents: string[],
): WatchdogScheduler & {
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(() => {
      lifecycleEvents.push('scheduler.start');
    }),
    stop: vi.fn(async () => {
      lifecycleEvents.push('scheduler.stop');
    }),
    runOnce: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => ({
      running: true,
      checkInFlight: false,
      channels: [],
    })),
  };
}

class FakeProcessTarget implements ProcessHandlerTarget {
  public exitCode: number | undefined;

  private readonly listeners = new Map<
    string,
    Set<(...arguments_: unknown[]) => void>
  >();

  public on(
    event: string,
    listener: (...arguments_: unknown[]) => void,
  ): void {
    const eventListeners = this.listeners.get(event) ?? new Set();
    eventListeners.add(listener);
    this.listeners.set(event, eventListeners);
  }

  public removeListener(
    event: string,
    listener: (...arguments_: unknown[]) => void,
  ): void {
    this.listeners.get(event)?.delete(listener);
  }

  public emit(event: string, ...arguments_: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...arguments_);
    }
  }

  public listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
