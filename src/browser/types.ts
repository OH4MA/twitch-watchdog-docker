import type { Page } from 'playwright';

import type { AppConfig } from '../config/AppConfig.js';
import type { Logger } from '../logging/Logger.js';

export type BrowserManagerConfig = Pick<
  AppConfig,
  'headless' | 'storageStatePath'
> & {
  readonly browser: Pick<
    AppConfig['browser'],
    | 'restartOnCrash'
    | 'viewportWidth'
    | 'viewportHeight'
    | 'blockImages'
    | 'blockFonts'
    | 'blockKnownTracking'
  >;
};

export interface BrowserLaunchOptions {
  readonly headless: boolean;
}

export interface BrowserContextOptions {
  readonly storageState: string;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
}

export interface BrowserPageAdapter {
  readonly page: Page;
  close(): Promise<void>;
  isClosed(): boolean;
  onCrash(listener: () => void): () => void;
  onClose(listener: () => void): () => void;
  onPopup(listener: (popup: Page) => void): () => void;
}

export interface BrowserContextAdapter {
  configureResourceBlocking(options: ResourceBlockingOptions): Promise<void>;
  newPage(): Promise<BrowserPageAdapter>;
  close(): Promise<void>;
}

export interface ResourceBlockingOptions {
  readonly blockImages: boolean;
  readonly blockFonts: boolean;
  readonly blockKnownTracking: boolean;
}

export interface BrowserAdapter {
  newContext(options: BrowserContextOptions): Promise<BrowserContextAdapter>;
  close(): Promise<void>;
  onDisconnected(listener: () => void): () => void;
}

export interface BrowserLauncher {
  launch(options: BrowserLaunchOptions): Promise<BrowserAdapter>;
}

export interface BrowserManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  createPage(channel: string): Promise<Page>;
  closePage(channel: string): Promise<void>;
  restart(): Promise<void>;
  getPageCount(): number;
}

export type BrowserInvalidationReason =
  | 'page_crashed'
  | 'page_closed'
  | 'browser_disconnected'
  | 'browser_restarted';

export interface BrowserInvalidation {
  readonly channel: string;
  readonly reason: BrowserInvalidationReason;
}

export type BrowserInvalidationObserver = (
  invalidation: BrowserInvalidation,
) => Promise<void> | void;

export type BrowserManagerLogger = Pick<
  Logger,
  'debug' | 'info' | 'warn' | 'error'
>;

export interface BrowserManagerDependencies {
  readonly launcher?: BrowserLauncher;
  readonly logger?: BrowserManagerLogger;
  readonly onInvalidated?: BrowserInvalidationObserver;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly restartBackoffMs?: number;
  readonly restartBackoffMaxMs?: number;
  readonly maxAutomaticRestartAttempts?: number;
  readonly restartAttemptResetMs?: number;
}

export interface PageEntry {
  readonly adapter: BrowserPageAdapter;
  unsubscribeCrash: () => void;
  unsubscribeClose: () => void;
  unsubscribePopup: () => void;
}

export interface DetachedResources {
  readonly browser: BrowserAdapter | undefined;
  readonly context: BrowserContextAdapter | undefined;
  readonly pages: readonly PageEntry[];
  readonly unsubscribeBrowser: (() => void) | undefined;
}

export interface RestartSchedule {
  readonly attempt: number;
  readonly delayMs: number;
  readonly recoveryEpoch: number;
}
