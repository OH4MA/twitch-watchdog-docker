import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  DefaultBrowserManager,
  type BrowserAdapter,
  type BrowserContextAdapter,
  type BrowserContextOptions,
  type BrowserInvalidation,
  type BrowserLaunchOptions,
  type BrowserLauncher,
  type BrowserManagerConfig,
  type BrowserManagerLogger,
  type BrowserPageAdapter,
} from '../../src/browser/BrowserManager.js';

const STORAGE_STATE_PATH = '/private/credentials/storage-state.json';

function createConfig(
  overrides: Partial<{
    headless: boolean;
    restartOnCrash: boolean;
  }> = {},
): BrowserManagerConfig {
  return {
    headless: overrides.headless ?? true,
    storageStatePath: STORAGE_STATE_PATH,
    browser: {
      restartOnCrash: overrides.restartOnCrash ?? true,
    },
  };
}

function createLogger(): BrowserManagerLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

class MockPageAdapter implements BrowserPageAdapter {
  public readonly page: Page;
  public readonly close = vi.fn(async (): Promise<void> => {
    const failure = this.closeFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }

    this.closed = true;
    this.emit(this.closeListeners);
  });

  private closed = false;
  private readonly crashListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly popupListeners = new Set<(popup: Page) => void>();
  private readonly closeFailures: Error[] = [];

  public constructor(public readonly name: string) {
    this.page = { mockPageName: name } as unknown as Page;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public onCrash(listener: () => void): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  public onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  public onPopup(listener: (popup: Page) => void): () => void {
    this.popupListeners.add(listener);
    return () => {
      this.popupListeners.delete(listener);
    };
  }

  public failNextClose(error = new Error('page close failed')): void {
    this.closeFailures.push(error);
  }

  public emitCrash(): void {
    this.emit(this.crashListeners);
  }

  public emitUnexpectedClose(): void {
    this.closed = true;
    this.emit(this.closeListeners);
  }

  public emitPopup(popup: Page): void {
    for (const listener of [...this.popupListeners]) {
      listener(popup);
    }
  }

  private emit(listeners: ReadonlySet<() => void>): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }
}

class MockContextAdapter implements BrowserContextAdapter {
  public readonly newPage = vi.fn(async (): Promise<BrowserPageAdapter> => {
    if (this.newPageImplementation !== undefined) {
      return this.newPageImplementation();
    }

    const result = this.pageResults.shift();
    if (result instanceof Error) {
      throw result;
    }
    if (result !== undefined) {
      return result;
    }

    return new MockPageAdapter(`generated-${this.newPage.mock.calls.length}`);
  });

  public readonly close = vi.fn(async (): Promise<void> => {
    const failure = this.closeFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }
  });

  public newPageImplementation:
    | (() => Promise<BrowserPageAdapter>)
    | undefined;
  private readonly pageResults: Array<MockPageAdapter | Error>;
  private readonly closeFailures: Error[] = [];

  public constructor(pageResults: Array<MockPageAdapter | Error> = []) {
    this.pageResults = [...pageResults];
  }

  public failNextClose(error = new Error('context close failed')): void {
    this.closeFailures.push(error);
  }
}

class MockBrowserAdapter implements BrowserAdapter {
  public readonly newContext = vi.fn(
    async (options: BrowserContextOptions): Promise<BrowserContextAdapter> => {
      this.contextOptions.push(options);
      if (this.contextResult instanceof Error) {
        throw this.contextResult;
      }
      return this.contextResult;
    },
  );

  public readonly close = vi.fn(async (): Promise<void> => {
    const failure = this.closeFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    this.emitDisconnected();
  });

  public readonly contextOptions: BrowserContextOptions[] = [];
  private readonly disconnectedListeners = new Set<() => void>();
  private readonly closeFailures: Error[] = [];

  public constructor(
    private readonly contextResult: MockContextAdapter | Error,
  ) {}

  public onDisconnected(listener: () => void): () => void {
    this.disconnectedListeners.add(listener);
    return () => {
      this.disconnectedListeners.delete(listener);
    };
  }

  public emitDisconnected(): void {
    for (const listener of [...this.disconnectedListeners]) {
      listener();
    }
  }

  public failNextClose(error = new Error('browser close failed')): void {
    this.closeFailures.push(error);
  }
}

class MockLauncher implements BrowserLauncher {
  public readonly launch = vi.fn(
    async (options: BrowserLaunchOptions): Promise<BrowserAdapter> => {
      this.options.push(options);
      const result = this.results.shift();
      if (result instanceof Error) {
        throw result;
      }
      if (result === undefined) {
        throw new Error('測試未提供下一個 browser');
      }
      return result;
    },
  );

  public readonly options: BrowserLaunchOptions[] = [];

  public constructor(
    private readonly results: Array<MockBrowserAdapter | Error>,
  ) {}
}

describe('DefaultBrowserManager', () => {
  it('以 headless、storageState 與 1280x720 啟動，重複 start 不重建', async () => {
    const context = new MockContextAdapter();
    const browser = new MockBrowserAdapter(context);
    const launcher = new MockLauncher([browser]);
    const manager = new DefaultBrowserManager(
      createConfig({ headless: false }),
      { launcher },
    );

    await Promise.all([manager.start(), manager.start()]);

    expect(launcher.launch).toHaveBeenCalledOnce();
    expect(launcher.options).toEqual([
      { headless: false, chromiumSandbox: true },
    ]);
    expect(browser.contextOptions).toEqual([
      {
        storageState: STORAGE_STATE_PATH,
        viewport: { width: 1280, height: 720 },
      },
    ]);
  });

  it('context 建立失敗時關閉 browser，之後可重新 start', async () => {
    const failedBrowser = new MockBrowserAdapter(
      new Error('context creation failed'),
    );
    const recoveredContext = new MockContextAdapter();
    const recoveredBrowser = new MockBrowserAdapter(recoveredContext);
    const launcher = new MockLauncher([failedBrowser, recoveredBrowser]);
    const manager = new DefaultBrowserManager(createConfig(), { launcher });

    await expect(manager.start()).rejects.toThrow('context creation failed');
    expect(failedBrowser.close).toHaveBeenCalledOnce();

    await manager.start();

    expect(launcher.launch).toHaveBeenCalledTimes(2);
    expect(recoveredBrowser.newContext).toHaveBeenCalledOnce();
  });

  it('未 start 時拒絕 createPage', async () => {
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([]),
    });

    await expect(manager.createPage('channel')).rejects.toThrow(
      'Browser Manager 尚未啟動',
    );
  });

  it('同一 channel 重複 createPage 回傳既有 page', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
    });
    await manager.start();

    const [first, second] = await Promise.all([
      manager.createPage('channel'),
      manager.createPage('channel'),
    ]);

    expect(first).toBe(page.page);
    expect(second).toBe(page.page);
    expect(context.newPage).toHaveBeenCalledOnce();
  });

  it('createPage 失敗不殘留 registry，下一次可重試', async () => {
    const recoveredPage = new MockPageAdapter('recovered');
    const context = new MockContextAdapter([
      new Error('new page failed'),
      recoveredPage,
    ]);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
    });
    await manager.start();

    await expect(manager.createPage('channel')).rejects.toThrow(
      'new page failed',
    );
    await expect(manager.createPage('channel')).resolves.toBe(
      recoveredPage.page,
    );
    expect(context.newPage).toHaveBeenCalledTimes(2);
  });

  it('closePage 可重複呼叫且正常關閉不通知 invalidation', async () => {
    const invalidations: BrowserInvalidation[] = [];
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
    });
    await manager.start();
    await manager.createPage('channel');

    await Promise.all([
      manager.closePage('channel'),
      manager.closePage('channel'),
    ]);

    expect(page.close).toHaveBeenCalledOnce();
    expect(invalidations).toEqual([]);
  });

  it('closePage 失敗時保留資源，stop 會再次清理', async () => {
    const page = new MockPageAdapter('channel');
    page.failNextClose();
    const context = new MockContextAdapter([page]);
    const browser = new MockBrowserAdapter(context);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([browser]),
    });
    await manager.start();
    await manager.createPage('channel');

    await expect(manager.closePage('channel')).rejects.toThrow(
      'page close failed',
    );
    await manager.stop();

    expect(page.close).toHaveBeenCalledTimes(2);
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('stop 關閉 pages、context、browser，併發與重複 stop 皆安全', async () => {
    const firstPage = new MockPageAdapter('first');
    const secondPage = new MockPageAdapter('second');
    const context = new MockContextAdapter([firstPage, secondPage]);
    const browser = new MockBrowserAdapter(context);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([browser]),
    });
    await manager.start();
    await manager.createPage('first');
    await manager.createPage('second');

    await Promise.all([manager.stop(), manager.stop()]);
    await manager.stop();

    expect(firstPage.close).toHaveBeenCalledOnce();
    expect(secondPage.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('stop 即使部分 close 失敗仍繼續清理其餘資源', async () => {
    const page = new MockPageAdapter('channel');
    page.failNextClose();
    const context = new MockContextAdapter([page]);
    context.failNextClose();
    const browser = new MockBrowserAdapter(context);
    browser.failNextClose();
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([browser]),
      logger,
    });
    await manager.start();
    await manager.createPage('channel');

    await expect(manager.stop()).resolves.toBeUndefined();

    expect(page.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('併發 manual restart 合併為一次並通知既有 channel 失效', async () => {
    const page = new MockPageAdapter('channel');
    const firstContext = new MockContextAdapter([page]);
    const firstBrowser = new MockBrowserAdapter(firstContext);
    const secondContext = new MockContextAdapter();
    const secondBrowser = new MockBrowserAdapter(secondContext);
    const launcher = new MockLauncher([firstBrowser, secondBrowser]);
    const logger = createLogger();
    const invalidations: BrowserInvalidation[] = [];
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
    });
    await manager.start();
    await manager.createPage('channel');

    await Promise.all([manager.restart(), manager.restart()]);

    expect(launcher.launch).toHaveBeenCalledTimes(2);
    expect(page.close).toHaveBeenCalledOnce();
    expect(firstContext.close).toHaveBeenCalledOnce();
    expect(firstBrowser.close).toHaveBeenCalledOnce();
    expect(invalidations).toEqual([
      { channel: 'channel', reason: 'browser_restarted' },
    ]);
    expect(logger.warn).toHaveBeenCalledWith('browser_restarted', {
      mode: 'manual',
      affectedChannelCount: 1,
    });
  });

  it('manual restart 啟動失敗時仍完成舊資源清理與失效通知', async () => {
    const page = new MockPageAdapter('channel');
    const firstContext = new MockContextAdapter([page]);
    const firstBrowser = new MockBrowserAdapter(firstContext);
    const launcher = new MockLauncher([
      firstBrowser,
      new Error('restart launch failed'),
    ]);
    const invalidations: BrowserInvalidation[] = [];
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
    });
    await manager.start();
    await manager.createPage('channel');

    await expect(manager.restart()).rejects.toThrow('restart launch failed');

    expect(page.close).toHaveBeenCalledOnce();
    expect(firstContext.close).toHaveBeenCalledOnce();
    expect(firstBrowser.close).toHaveBeenCalledOnce();
    expect(invalidations).toEqual([
      { channel: 'channel', reason: 'browser_restarted' },
    ]);
  });

  it('page crash 移除 registry、清理 page 並只通知一次', async () => {
    const crashedPage = new MockPageAdapter('crashed');
    const replacementPage = new MockPageAdapter('replacement');
    const context = new MockContextAdapter([crashedPage, replacementPage]);
    const invalidations: BrowserInvalidation[] = [];
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
    });
    await manager.start();
    await manager.createPage('channel');

    crashedPage.emitCrash();

    await vi.waitFor(() => {
      expect(invalidations).toEqual([
        { channel: 'channel', reason: 'page_crashed' },
      ]);
    });
    await expect(manager.createPage('channel')).resolves.toBe(
      replacementPage.page,
    );
    expect(crashedPage.close).toHaveBeenCalledOnce();
  });

  it('非預期 page close 通知失效且可重建相同 channel', async () => {
    const closedPage = new MockPageAdapter('closed');
    const replacementPage = new MockPageAdapter('replacement');
    const context = new MockContextAdapter([closedPage, replacementPage]);
    const onInvalidated = vi.fn();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      onInvalidated,
    });
    await manager.start();
    await manager.createPage('channel');

    closedPage.emitUnexpectedClose();

    await vi.waitFor(() => {
      expect(onInvalidated).toHaveBeenCalledWith({
        channel: 'channel',
        reason: 'page_closed',
      });
    });
    await expect(manager.createPage('channel')).resolves.toBe(
      replacementPage.page,
    );
    expect(closedPage.close).not.toHaveBeenCalled();
  });

  it('頁面 popup 立即關閉且不加入 channel registry', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
    });
    const popupClose = vi.fn(async () => undefined);
    const popup = {
      isClosed: () => false,
      close: popupClose,
    } as unknown as Page;
    await manager.start();
    await manager.createPage('channel');

    page.emitPopup(popup);

    await vi.waitFor(() => {
      expect(popupClose).toHaveBeenCalledOnce();
    });
    expect(logger.warn).toHaveBeenCalledWith('browser_popup_blocked', {
      channel: 'channel',
    });
    expect(context.newPage).toHaveBeenCalledOnce();
  });

  it('browser disconnect 通知全部 channel，並以 single-flight 退避重啟', async () => {
    const firstPage = new MockPageAdapter('first');
    const secondPage = new MockPageAdapter('second');
    const firstContext = new MockContextAdapter([firstPage, secondPage]);
    const firstBrowser = new MockBrowserAdapter(firstContext);
    const recoveredContext = new MockContextAdapter();
    const recoveredBrowser = new MockBrowserAdapter(recoveredContext);
    const launcher = new MockLauncher([firstBrowser, recoveredBrowser]);
    const sleep = vi.fn(async () => undefined);
    const invalidations: BrowserInvalidation[] = [];
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      sleep,
      restartBackoffMs: 25,
      onInvalidated: (invalidation) => {
        invalidations.push(invalidation);
      },
    });
    await manager.start();
    await manager.createPage('first');
    await manager.createPage('second');

    firstBrowser.emitDisconnected();
    firstBrowser.emitDisconnected();

    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(2);
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(25);
    expect(invalidations).toEqual([
      { channel: 'first', reason: 'browser_disconnected' },
      { channel: 'second', reason: 'browser_disconnected' },
    ]);
    expect(firstPage.close).toHaveBeenCalledOnce();
    expect(secondPage.close).toHaveBeenCalledOnce();
    expect(firstContext.close).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('browser_restarted', {
      mode: 'automatic',
      attempt: 1,
    });
  });

  it('restartOnCrash=false 時只清理與通知，不自動重啟', async () => {
    const page = new MockPageAdapter('channel');
    const context = new MockContextAdapter([page]);
    const browser = new MockBrowserAdapter(context);
    const launcher = new MockLauncher([browser]);
    const onInvalidated = vi.fn();
    const manager = new DefaultBrowserManager(
      createConfig({ restartOnCrash: false }),
      { launcher, onInvalidated },
    );
    await manager.start();
    await manager.createPage('channel');

    browser.emitDisconnected();

    await vi.waitFor(() => {
      expect(onInvalidated).toHaveBeenCalledWith({
        channel: 'channel',
        reason: 'browser_disconnected',
      });
    });
    expect(launcher.launch).toHaveBeenCalledOnce();
  });

  it('自動重啟退避期間 stop 會取消後續復原', async () => {
    const browser = new MockBrowserAdapter(new MockContextAdapter());
    const recoveredBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([browser, recoveredBrowser]);
    const sleepGate = createDeferred<void>();
    const sleep = vi.fn(() => sleepGate.promise);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      sleep,
    });
    await manager.start();

    browser.emitDisconnected();
    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalledOnce();
    });
    await manager.stop();
    sleepGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(launcher.launch).toHaveBeenCalledOnce();
  });

  it('新的 browser crash 會取代仍在等待的過期復原排程', async () => {
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const secondBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const recoveredBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([
      firstBrowser,
      secondBrowser,
      recoveredBrowser,
    ]);
    const firstSleepGate = createDeferred<void>();
    let sleepCallCount = 0;
    const sleep = vi.fn(() => {
      sleepCallCount += 1;
      return sleepCallCount === 1
        ? firstSleepGate.promise
        : Promise.resolve();
    });
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      sleep,
    });
    await manager.start();

    firstBrowser.emitDisconnected();
    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalledOnce();
    });
    await manager.start();
    secondBrowser.emitDisconnected();

    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(3);
    });
    firstSleepGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(launcher.launch).toHaveBeenCalledTimes(3);
  });

  it('自動重啟失敗只嘗試一次，且不洩漏 storageState path', async () => {
    const context = new MockContextAdapter();
    const browser = new MockBrowserAdapter(context);
    const restartError = new Error(
      `storageState=${STORAGE_STATE_PATH} storageState={"cookies":[{"value":"secret-cookie"}]}`,
    );
    const launcher = new MockLauncher([browser, restartError]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      sleep: async () => undefined,
      maxAutomaticRestartAttempts: 1,
    });
    await manager.start();

    browser.emitDisconnected();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        'browser_restart_failed',
        expect.objectContaining({ mode: 'automatic', attempt: 1 }),
      );
    });
    await Promise.resolve();
    expect(launcher.launch).toHaveBeenCalledTimes(2);
    const serializedLogs = JSON.stringify({
      warn: vi.mocked(logger.warn).mock.calls,
      error: vi.mocked(logger.error).mock.calls,
    });
    expect(serializedLogs).not.toContain(STORAGE_STATE_PATH);
    expect(serializedLogs).not.toContain('secret-cookie');
  });

  it('自動重啟第一次失敗後以遞增退避再次嘗試', async () => {
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const recoveredBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([
      firstBrowser,
      new Error('first restart failed'),
      recoveredBrowser,
    ]);
    const logger = createLogger();
    const sleep = vi.fn(async () => undefined);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      sleep,
      restartBackoffMs: 25,
      maxAutomaticRestartAttempts: 2,
    });
    await manager.start();

    firstBrowser.emitDisconnected();

    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(3);
    });
    expect(sleep.mock.calls).toEqual([[25], [50]]);
    expect(logger.error).toHaveBeenCalledWith(
      'browser_restart_failed',
      expect.objectContaining({ mode: 'automatic', attempt: 1 }),
    );
    expect(logger.warn).toHaveBeenCalledWith('browser_restarted', {
      mode: 'automatic',
      attempt: 2,
    });
  });

  it('快速連續 browser crash 達上限後停止自動重啟', async () => {
    const firstBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const secondBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const thirdBrowser = new MockBrowserAdapter(new MockContextAdapter());
    const launcher = new MockLauncher([
      firstBrowser,
      secondBrowser,
      thirdBrowser,
    ]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher,
      logger,
      sleep: async () => undefined,
      now: () => 1_000,
      maxAutomaticRestartAttempts: 2,
    });
    await manager.start();

    firstBrowser.emitDisconnected();
    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(2);
    });
    secondBrowser.emitDisconnected();
    await vi.waitFor(() => {
      expect(launcher.launch).toHaveBeenCalledTimes(3);
    });
    thirdBrowser.emitDisconnected();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        'browser_restart_limit_reached',
        { maxAttempts: 2 },
      );
    });
    expect(launcher.launch).toHaveBeenCalledTimes(3);
  });

  it('invalidation observer 拋錯不阻塞 page 清理與重建', async () => {
    const failedPage = new MockPageAdapter('failed');
    const replacementPage = new MockPageAdapter('replacement');
    const context = new MockContextAdapter([failedPage, replacementPage]);
    const logger = createLogger();
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([new MockBrowserAdapter(context)]),
      logger,
      onInvalidated: async () => {
        throw new Error('observer failed');
      },
    });
    await manager.start();
    await manager.createPage('channel');

    failedPage.emitCrash();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        'browser_invalidation_observer_failed',
        expect.objectContaining({
          channel: 'channel',
          reason: 'page_crashed',
        }),
      );
    });
    await expect(manager.createPage('channel')).resolves.toBe(
      replacementPage.page,
    );
  });

  it('createPage 進行中呼叫 stop 時會等待建立完成後再清理', async () => {
    const page = new MockPageAdapter('delayed');
    const context = new MockContextAdapter();
    const deferred = createDeferred<BrowserPageAdapter>();
    context.newPageImplementation = () => deferred.promise;
    const browser = new MockBrowserAdapter(context);
    const manager = new DefaultBrowserManager(createConfig(), {
      launcher: new MockLauncher([browser]),
    });
    await manager.start();

    const createPromise = manager.createPage('channel');
    const stopPromise = manager.stop();
    deferred.resolve(page);

    await expect(createPromise).resolves.toBe(page.page);
    await stopPromise;

    expect(page.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });
});

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
