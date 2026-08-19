import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import type { AppConfig } from '../config/AppConfig.js';

export type DiagnosticLimitValue = number | string | null;

export interface RuntimeResourceLimitsSnapshot {
  readonly memoryMaxBytes: DiagnosticLimitValue;
  readonly pidsMax: DiagnosticLimitValue;
}

export interface RuntimeDiagnosticsBrowser {
  getBrowserGeneration(): number;
  getBrowserVersion(): string | null;
}

export interface RuntimeStartupDiagnostics {
  readonly runId: string;
  readonly applicationVersion: string | null;
  readonly gitCommit: string | null;
  readonly nodeVersion: string;
  readonly playwrightVersion: string | null;
  readonly browserEngine: string;
  readonly browserVersion: string | null;
  readonly browserGeneration: number;
  readonly memoryMaxBytes: DiagnosticLimitValue;
  readonly pidsMax: DiagnosticLimitValue;
  readonly safeConfigFingerprint: string;
}

export type StartupDiagnosticsProvider = () =>
  | RuntimeStartupDiagnostics
  | Promise<RuntimeStartupDiagnostics>;

export interface RuntimeDiagnosticsOptions {
  readonly config: AppConfig;
  readonly browserManager: RuntimeDiagnosticsBrowser;
  readonly resourceLimits?: {
    getLatestResourceLimits(): RuntimeResourceLimitsSnapshot;
  };
  readonly env?: NodeJS.ProcessEnv;
  readonly browserEngine?: string;
  readonly runId?: string;
  readonly nodeVersion?: string;
}

const PROCESS_RUN_ID = randomUUID();
const require = createRequire(import.meta.url);
const DEFAULT_APPLICATION_VERSION = readPackageVersion('../../package.json');
const DEFAULT_PLAYWRIGHT_VERSION = readPackageVersion(
  'playwright/package.json',
);

export function createRuntimeStartupDiagnostics(
  options: RuntimeDiagnosticsOptions,
): RuntimeStartupDiagnostics {
  const env = options.env ?? process.env;
  const limits = options.resourceLimits?.getLatestResourceLimits() ?? {
    memoryMaxBytes: null,
    pidsMax: null,
  };

  return {
    runId: safeRunId(options.runId) ?? PROCESS_RUN_ID,
    applicationVersion: safeVersion(
      env.APPLICATION_VERSION ??
        env.npm_package_version ??
        DEFAULT_APPLICATION_VERSION,
    ),
    gitCommit: safeGitCommit(env.GIT_COMMIT),
    nodeVersion: safeVersion(options.nodeVersion ?? process.version) ?? 'unknown',
    playwrightVersion: safeVersion(
      env.PLAYWRIGHT_VERSION ?? DEFAULT_PLAYWRIGHT_VERSION,
    ),
    browserEngine: safeEngine(options.browserEngine),
    browserVersion: safeVersion(options.browserManager.getBrowserVersion()),
    browserGeneration: Math.max(
      0,
      Math.trunc(options.browserManager.getBrowserGeneration()),
    ),
    memoryMaxBytes: limits.memoryMaxBytes,
    pidsMax: limits.pidsMax,
    safeConfigFingerprint: createSafeConfigFingerprint(options.config),
  };
}

export function createSafeConfigFingerprint(config: AppConfig): string {
  const safeConfig = {
    schemaVersion: 1,
    channels: config.channels.map((channel) =>
      channel.trim().toLocaleLowerCase('en-US'),
    ),
    checkIntervalSeconds: config.checkIntervalSeconds,
    maxConcurrentStreams: config.maxConcurrentStreams,
    headless: config.headless,
    logLevel: config.logLevel,
    browser: {
      engine: config.browser.engine,
      navigationTimeoutMs: config.browser.navigationTimeoutMs,
      pageHealthCheckIntervalSeconds:
        config.browser.pageHealthCheckIntervalSeconds,
      rewardCheckIntervalSeconds: config.browser.rewardCheckIntervalSeconds,
      pageRefreshIntervalSeconds: config.browser.pageRefreshIntervalSeconds,
      restartOnCrash: config.browser.restartOnCrash,
      streamQuality: config.browser.streamQuality,
      enforceStreamQualitySeconds:
        config.browser.enforceStreamQualitySeconds,
      viewportWidth: config.browser.viewportWidth,
      viewportHeight: config.browser.viewportHeight,
      muteAudio: config.browser.muteAudio,
      blockImages: config.browser.blockImages,
      blockFonts: config.browser.blockFonts,
      blockKnownTracking: config.browser.blockKnownTracking,
      disableChat: config.browser.disableChat,
      resourceTelemetryIntervalSeconds:
        config.browser.resourceTelemetryIntervalSeconds,
      recovery: config.browser.recovery,
      sessionStart: config.browser.sessionStart,
      resourceGuard: config.browser.resourceGuard,
    },
    integrations: {
      telegramEnabled: config.telegram.enabled,
      discordEnabled: config.discord.enabled,
      discordDirectMessages: config.discord.allowDirectMessages,
    },
  };

  return createHash('sha256')
    .update(JSON.stringify(safeConfig))
    .digest('hex');
}

function safeVersion(value: string | null | undefined): string | null {
  if (
    value === null ||
    value === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._+()-]{0,127}$/u.test(value)
  ) {
    return null;
  }
  return value;
}

function safeGitCommit(value: string | undefined): string | null {
  return value !== undefined && /^[a-f0-9]{7,64}$/iu.test(value)
    ? value.toLocaleLowerCase('en-US')
    : null;
}

function safeEngine(value: string | undefined): string {
  return value !== undefined && /^(?:firefox|chromium)$/u.test(value)
    ? value
    : 'unknown';
}

function safeRunId(value: string | undefined): string | null {
  return value !== undefined && /^[A-Za-z0-9-]{8,64}$/u.test(value)
    ? value
    : null;
}

function readPackageVersion(packagePath: string): string | null {
  try {
    const metadata: unknown = require(packagePath);
    if (
      typeof metadata === 'object' &&
      metadata !== null &&
      'version' in metadata &&
      typeof metadata.version === 'string'
    ) {
      return safeVersion(metadata.version);
    }
  } catch {
    // Missing package metadata is represented explicitly as null.
  }
  return null;
}
