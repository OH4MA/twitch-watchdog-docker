import type { Locator, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserManager } from '../../src/browser/BrowserManager.js';
import {
  CHANNEL_HEALTH_SELECTORS,
  DefaultChannelSession,
  DefaultChannelSessionFactory,
  createChannelUrl,
  evaluateChannelHealth,
  type ChannelHealthResult,
  type ChannelSessionLogger,
} from '../../src/browser/ChannelSession.js';
import type {
  RewardClaimer,
  RewardClaimResult,
} from '../../src/browser/RewardClaimer.js';
import type { AppConfig } from '../../src/config/AppConfig.js';
import { LOG_EVENTS } from '../../src/logging/index.js';

type HealthMarker =
  | 'loginRequired'
  | 'liveContent'
  | 'error'
  | 'offline';

interface MockPageControls {
  readonly page: Page;
  readonly setDefaultNavigationTimeout: ReturnType<typeof vi.fn>;
  readonly goto: ReturnType<typeof vi.fn>;
  readonly reload: ReturnType<typeof vi.fn>;
  setMarker(marker: HealthMarker | undefined): void;
  setUrl(url: string): void;
  setClosed(closed: boolean): void;
}

const CHANNEL = 'streamer_one';
const TARGET_URL = `https://www.twitch.tv/${CHANNEL}`;
const NOW = new Date('2026-06-14T12:00:00.000Z');

function createConfig(
  overrides: Partial<AppConfig['browser']> = {},
): Pick<AppConfig, 'channels' | 'browser'> {
  return {
    channels: [CHANNEL],
    browser: {
      navigationTimeoutMs: overrides.navigationTimeoutMs ?? 30_000,
      pageHealthCheckIntervalSeconds:
        overrides.pageHealthCheckIntervalSeconds ?? 30,
      rewardCheckIntervalSeconds:
        overrides.rewardCheckIntervalSeconds ?? 15,
      restartOnCrash: overrides.restartOnCrash ?? true,
    },
  };
}

function createMockPage(input: {
  readonly marker?: HealthMarker;
  readonly url?: string;
  readonly gotoError?: Error;
  readonly finalUrl?: string;
  readonly reloadError?: Error;
} = {}): MockPageControls {
  let marker = input.marker;
  let currentUrl = input.url ?? 'about:blank';
  let closed = false;

  const locator = (selector: string): Locator => {
    const visible =
      marker !== undefined &&
      selector === CHANNEL_HEALTH_SELECTORS[marker];
    const mockLocator = {
      first(): Locator {
        return mockLocator as unknown as Locator;
      },
      async isVisible(): Promise<boolean> {
        return visible;
      },
    };
    return mockLocator as unknown as Locator;
  };

  const setDefaultNavigationTimeout = vi.fn();
  const goto = vi.fn(async (url: string): Promise<null> => {
    if (input.gotoError !== undefined) {
      throw input.gotoError;
    }
    currentUrl = input.finalUrl ?? url;
    return null;
  });
  const reload = vi.fn(async (): Promise<null> => {
    if (input.reloadError !== undefined) {
      throw input.reloadError;
    }
    return null;
  });

  const page = {
    setDefaultNavigationTimeout,
    goto,
    reload,
    url: () => currentUrl,
    isClosed: () => closed,
    locator,
  } as unknown as Page;

  return {
    page,
    setDefaultNavigationTimeout,
    goto,
    reload,
    setMarker(value): void {
      marker = value;
    },
    setUrl(value): void {
      currentUrl = value;
    },
    setClosed(value): void {
      closed = value;
    },
  };
}

function createBrowserManager(page: Page): {
  readonly manager: BrowserManager;
  readonly createPage: ReturnType<typeof vi.fn>;
  readonly closePage: ReturnType<typeof vi.fn>;
} {
  const createPage = vi.fn(async () => page);
  const closePage = vi.fn(async () => undefined);
  return {
    manager: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      createPage,
      closePage,
      restart: vi.fn(async () => undefined),
    },
    createPage,
    closePage,
  };
}

function createRewardClaimer(
  implementation: (
    page: Page,
    channel: string,
  ) => Promise<RewardClaimResult> = async (_page, channel) => ({
    status: 'not_found',
    channel,
    checkedAt: NOW.toISOString(),
  }),
): {
  readonly claimer: RewardClaimer;
  readonly claimIfAvailable: ReturnType<typeof vi.fn>;
} {
  const claimIfAvailable = vi.fn(implementation);
  return {
    claimer: { claimIfAvailable },
    claimIfAvailable,
  };
}

function createLogger(): {
  readonly logger: ChannelSessionLogger;
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return {
    logger: {
      debug: vi.fn(),
      info,
      warn,
      error,
    },
    info,
    warn,
    error,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value): void {
      resolvePromise?.(value);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DefaultChannelSession', () => {
  it('併發 start 只建立一次 page、設定 timeout 並導覽編碼後 URL', async () => {
    const mockPage = createMockPage();
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig({ navigationTimeoutMs: 12_345 }),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });

    await Promise.all([session.start(), session.start(), session.start()]);

    expect(browser.createPage).toHaveBeenCalledOnce();
    expect(browser.createPage).toHaveBeenCalledWith(CHANNEL);
    expect(mockPage.setDefaultNavigationTimeout).toHaveBeenCalledWith(
      12_345,
    );
    expect(mockPage.goto).toHaveBeenCalledWith(TARGET_URL);
    expect(session.state).toBe('watching');

    await session.stop('test_complete');
    await Promise.all([session.start(), session.start()]);
    expect(browser.createPage).toHaveBeenCalledTimes(2);
    expect(session.state).toBe('watching');
    await session.stop('restart_complete');
  });

  it('start 失敗會透過 manager 清理 page 並進入 failed', async () => {
    const mockPage = createMockPage({
      gotoError: new Error('navigation failed'),
    });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });

    await expect(session.start()).rejects.toThrow('navigation failed');

    expect(browser.closePage).toHaveBeenCalledWith(CHANNEL);
    expect(session.state).toBe('failed');
  });

  it('start 導向非預期 origin 時立即關閉 page 且不啟動 session', async () => {
    const mockPage = createMockPage({
      finalUrl: 'https://example.test/fake-channel',
    });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });

    await expect(session.start()).rejects.toThrow('非預期 Twitch URL');
    expect(browser.closePage).toHaveBeenCalledWith(CHANNEL);
    expect(session.state).toBe('failed');
  });

  it('stop 可重複呼叫、關閉 page 並記錄停止原因', async () => {
    const mockPage = createMockPage();
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const logs = createLogger();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      logger: logs.logger,
    });
    await session.start();

    await Promise.all([
      session.stop('stream_offline'),
      session.stop('duplicate_stop'),
    ]);

    expect(browser.closePage).toHaveBeenCalledOnce();
    expect(session.state).toBe('stopped');
    expect(logs.info).toHaveBeenCalledWith(LOG_EVENTS.WATCH_STOPPED, {
      channel: CHANNEL,
      reason: 'stream_offline',
    });
  });

  it('正常 Twitch URL 且有播放器時為 healthy', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });
    await session.start();

    await expect(session.checkHealth()).resolves.toEqual({
      healthy: true,
      reason: 'live',
    });
    expect(session.state).toBe('watching');

    await session.stop('test_complete');
  });

  it.each([
    ['loginRequired', 'login_required'],
    ['error', 'error_page'],
    ['offline', 'offline'],
  ] as const)('明確辨識 %s 頁面', async (marker, reason) => {
    const mockPage = createMockPage({ marker });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });
    await session.start();

    await expect(session.checkHealth()).resolves.toEqual({
      healthy: false,
      reason,
    });

    await session.stop('test_complete');
  });

  it('URL mismatch 與 page closed 回傳明確原因', async () => {
    const mismatchPage = createMockPage({ marker: 'liveContent' });
    mismatchPage.setUrl('https://www.twitch.tv/another_channel');
    await expect(
      evaluateChannelHealth(mismatchPage.page, TARGET_URL),
    ).resolves.toEqual({
      healthy: false,
      reason: 'url_mismatch',
    });

    mismatchPage.setClosed(true);
    await expect(
      evaluateChannelHealth(mismatchPage.page, TARGET_URL),
    ).resolves.toEqual({
      healthy: false,
      reason: 'page_closed',
    });
  });

  it('第一次失敗 reload 並 recovering，下一次健康才恢復 watching', async () => {
    const mockPage = createMockPage({ marker: 'loginRequired' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });
    await session.start();

    await expect(session.checkHealth()).resolves.toEqual({
      healthy: false,
      reason: 'login_required',
    });
    expect(mockPage.reload).toHaveBeenCalledOnce();
    expect(session.state).toBe('recovering');

    mockPage.setMarker('liveContent');
    await expect(session.checkHealth()).resolves.toEqual({
      healthy: true,
      reason: 'live',
    });
    expect(session.state).toBe('watching');

    await session.stop('test_complete');
  });

  it('連續三次失敗後停止 timers、關閉 page 並進入 failed', async () => {
    const mockPage = createMockPage({ marker: 'offline' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const onInvalidated = vi.fn(async () => undefined);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      onInvalidated,
    });
    await session.start();

    await session.checkHealth();
    await session.checkHealth();
    await session.checkHealth();

    expect(mockPage.reload).toHaveBeenCalledOnce();
    expect(browser.closePage).toHaveBeenCalledOnce();
    expect(session.state).toBe('failed');
    await vi.waitFor(() => {
      expect(onInvalidated).toHaveBeenCalledWith(
        CHANNEL,
        'health_failure_threshold',
      );
    });
    await expect(session.checkHealth()).resolves.toEqual({
      healthy: false,
      reason: 'page_closed',
    });
  });

  it('reward click_failed 只回報結果，不停止 session', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer(async (_page, channel) => ({
      status: 'click_failed',
      channel,
      checkedAt: NOW.toISOString(),
      error: 'click failed',
    }));
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });
    await session.start();

    await expect(session.tickRewardClaim()).resolves.toMatchObject({
      status: 'click_failed',
    });
    expect(session.state).toBe('watching');
    expect(browser.closePage).not.toHaveBeenCalled();

    await session.stop('test_complete');
  });

  it('獎勵操作前 URL 已偏離目標時不呼叫 RewardClaimer', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      now: () => NOW,
    });
    await session.start();
    mockPage.setUrl('https://example.test/fake-channel');

    await expect(session.tickRewardClaim()).resolves.toEqual({
      status: 'not_found',
      channel: CHANNEL,
      checkedAt: NOW.toISOString(),
    });
    expect(rewards.claimIfAvailable).not.toHaveBeenCalled();

    await session.stop('test_complete');
  });

  it('timer 工作不重入，stop 會清除 timer 並等待當前工作', async () => {
    vi.useFakeTimers();
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const health = deferred<ChannelHealthResult>();
    const reward = deferred<RewardClaimResult>();
    const healthEvaluator = vi.fn(() => health.promise);
    const rewards = createRewardClaimer(() => reward.promise);
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig({
        pageHealthCheckIntervalSeconds: 1,
        rewardCheckIntervalSeconds: 1,
      }),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      healthEvaluator,
    });
    await session.start();

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(healthEvaluator).toHaveBeenCalledOnce();
    expect(rewards.claimIfAvailable).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(healthEvaluator).toHaveBeenCalledOnce();
    expect(rewards.claimIfAvailable).toHaveBeenCalledOnce();

    const stopPromise = session.stop('shutdown');
    await Promise.resolve();
    expect(browser.closePage).not.toHaveBeenCalled();

    health.resolve({ healthy: true, reason: 'live' });
    reward.resolve({
      status: 'not_found',
      channel: CHANNEL,
      checkedAt: NOW.toISOString(),
    });
    await stopPromise;
    expect(browser.closePage).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(healthEvaluator).toHaveBeenCalledOnce();
    expect(rewards.claimIfAvailable).toHaveBeenCalledOnce();
  });

  it('RewardClaimer 拋錯時轉為 click_failed 且避免 timer rejection', async () => {
    const mockPage = createMockPage({ marker: 'liveContent' });
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer(async () => {
      throw new Error('access_token=secret-value');
    });
    const logs = createLogger();
    const session = new DefaultChannelSession({
      channel: CHANNEL,
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
      logger: logs.logger,
      now: () => NOW,
    });
    await session.start();

    const result = await session.tickRewardClaim();

    expect(result.status).toBe('click_failed');
    if (result.status === 'click_failed') {
      expect(result.error).not.toContain('secret-value');
    }
    expect(session.state).toBe('watching');
    expect(logs.warn).toHaveBeenCalledWith(
      LOG_EVENTS.REWARD_CLAIM_FAILED,
      expect.objectContaining({ channel: CHANNEL }),
    );

    await session.stop('test_complete');
  });
});

describe('ChannelSession helpers and factory', () => {
  it('只接受設定模組已驗證且存在於 channels 的名稱', () => {
    const mockPage = createMockPage();
    const browser = createBrowserManager(mockPage.page);
    const rewards = createRewardClaimer();
    const factory = new DefaultChannelSessionFactory({
      config: createConfig(),
      browserManager: browser.manager,
      rewardClaimer: rewards.claimer,
    });

    expect(factory.create(CHANNEL).channel).toBe(CHANNEL);
    expect(() => factory.create('../escape')).toThrow(
      'Channel 必須是 1 到 25 字元的英數字或底線',
    );
    expect(() => factory.create('not_configured')).toThrow(
      '不在已驗證的設定清單中',
    );
  });

  it('createChannelUrl 使用 URL encoding 並拒絕不合法 channel', () => {
    expect(createChannelUrl('Valid_Channel')).toBe(
      'https://www.twitch.tv/Valid_Channel',
    );
    expect(() => createChannelUrl('invalid/channel')).toThrow();
  });
});
