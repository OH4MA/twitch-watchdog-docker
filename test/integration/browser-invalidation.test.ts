import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  DefaultBrowserManager,
  type BrowserAdapter,
  type BrowserContextAdapter,
  type BrowserLauncher,
  type BrowserPageAdapter,
} from '../../src/browser/BrowserManager.js';
import {
  selectActiveChannels,
  type StreamSelector,
} from '../../src/scheduler/StreamSelector.js';
import { DefaultWatchdogScheduler } from '../../src/scheduler/WatchdogScheduler.js';
import { DefaultSessionManager } from '../../src/sessions/index.js';
import type { LiveStatusProvider } from '../../src/twitch/index.js';
import { RecordingChannelSessionFactory } from '../helpers/recording-session-factory.js';
import { createTestConfig } from '../helpers/test-config.js';
import {
  createFixedClock,
  createRecordingLogger,
} from '../helpers/test-logger.js';

describe('Browser invalidation 到 scheduler 重建整合', () => {
  it('page crash 經 callback invalidate session，下一輪 reconcile 重建', async () => {
    const channel = 'recoverable_channel';
    const config = createTestConfig({
      channels: [channel],
      maxConcurrentStreams: 1,
      browser: { restartOnCrash: false },
    });
    const clock = createFixedClock();
    const recordingLogger = createRecordingLogger(clock);
    const firstPage = new TestPageAdapter();
    const replacementPage = new TestPageAdapter();
    const context = new TestContextAdapter([firstPage, replacementPage]);
    const browser = new TestBrowserAdapter(context);
    const wiring: { sessionManager?: DefaultSessionManager } = {};
    const browserManager = new DefaultBrowserManager(config, {
      launcher: new TestBrowserLauncher(browser),
      logger: recordingLogger.logger,
      onInvalidated: async ({ channel: invalidatedChannel, reason }) => {
        const manager = wiring.sessionManager;
        if (manager === undefined) {
          throw new Error('Session Manager 尚未完成測試 wiring');
        }
        await manager.invalidate(invalidatedChannel, reason);
      },
    });
    const sessionFactory = new RecordingChannelSessionFactory({
      onStart: async (session) => {
        await browserManager.createPage(session.channel);
      },
      onStop: async (session) => {
        await browserManager.closePage(session.channel);
      },
    });
    const sessionManager = new DefaultSessionManager(sessionFactory, {
      logger: recordingLogger.logger,
    });
    wiring.sessionManager = sessionManager;
    const liveStatusProvider: LiveStatusProvider = {
      async getLiveStatuses(channels) {
        return channels.map((configuredChannel) => ({
          channel: configuredChannel,
          isLive: true,
          checkedAt: clock.date().toISOString(),
        }));
      },
    };
    const streamSelector: StreamSelector = { selectActiveChannels };
    const scheduler = new DefaultWatchdogScheduler({
      config,
      liveStatusProvider,
      streamSelector,
      sessionManager,
      logger: recordingLogger.logger,
      now: clock.date,
    });

    await browserManager.start();
    await scheduler.runOnce();

    expect(sessionManager.getActiveChannels()).toEqual([channel]);
    expect(context.newPageCalls).toBe(1);
    expect(sessionFactory.sessionsFor(channel)).toHaveLength(1);

    firstPage.emitCrash();

    await vi.waitFor(() => {
      expect(sessionManager.getActiveChannels()).toEqual([]);
    });
    expect(firstPage.closeCalls).toBe(1);
    expect(sessionFactory.events).toContainEqual({
      type: 'stopped',
      channel,
      generation: 1,
      reason: 'page_crashed',
    });

    await scheduler.runOnce();

    expect(sessionManager.getActiveChannels()).toEqual([channel]);
    expect(context.newPageCalls).toBe(2);
    expect(sessionFactory.sessionsFor(channel)).toHaveLength(2);
    expect(sessionFactory.events).toContainEqual({
      type: 'started',
      channel,
      generation: 2,
    });

    await sessionManager.stopAll('test_cleanup');
    await browserManager.stop();
  });
});

class TestPageAdapter implements BrowserPageAdapter {
  public readonly page = {} as Page;
  public closeCalls = 0;
  private closed = false;
  private readonly crashListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly popupListeners = new Set<(popup: Page) => void>();

  public async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
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

  public emitCrash(): void {
    for (const listener of [...this.crashListeners]) {
      listener();
    }
  }
}

class TestContextAdapter implements BrowserContextAdapter {
  public newPageCalls = 0;
  public closeCalls = 0;

  public constructor(private readonly pages: BrowserPageAdapter[]) {}

  public async configureResourceBlocking(): Promise<void> {}

  public async newPage(): Promise<BrowserPageAdapter> {
    const page = this.pages[this.newPageCalls];
    this.newPageCalls += 1;
    if (page === undefined) {
      throw new Error('沒有可用的測試 page');
    }
    return page;
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class TestBrowserAdapter implements BrowserAdapter {
  public closeCalls = 0;
  private readonly disconnectListeners = new Set<() => void>();

  public constructor(private readonly context: BrowserContextAdapter) {}

  public async newContext(): Promise<BrowserContextAdapter> {
    return this.context;
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }

  public onDisconnected(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }
}

class TestBrowserLauncher implements BrowserLauncher {
  public constructor(private readonly browser: BrowserAdapter) {}

  public async launch(): Promise<BrowserAdapter> {
    return this.browser;
  }
}
