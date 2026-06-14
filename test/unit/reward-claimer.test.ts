import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  COMMUNITY_POINTS_CLAIM_BUTTON_SELECTOR,
  COMMUNITY_POINTS_SUMMARY_SELECTOR,
  REWARD_BUTTON_LIKE_SELECTOR,
  RewardClaimer,
  type RewardClaimerLogger,
} from '../../src/browser/RewardClaimer.js';
import { LOG_EVENTS, REDACTED_VALUE } from '../../src/logging/index.js';

const START_TIME = new Date('2026-06-14T12:00:00.000Z');

type MockElement = {
  readonly visible?: boolean;
  readonly disabled?: boolean;
  readonly click?: () => Promise<void>;
  readonly descendants?: readonly MockElement[];
};

class MockLocator {
  public constructor(
    private readonly elements: readonly MockElement[],
  ) {}

  public async count(): Promise<number> {
    return this.elements.length;
  }

  public nth(index: number): MockLocator {
    const element = this.elements[index];
    return new MockLocator(element === undefined ? [] : [element]);
  }

  public locator(selector: string): MockLocator {
    if (selector !== REWARD_BUTTON_LIKE_SELECTOR) {
      return new MockLocator([]);
    }

    return new MockLocator(
      this.elements.flatMap((element) => element.descendants ?? []),
    );
  }

  public async isVisible(): Promise<boolean> {
    return this.elements[0]?.visible ?? false;
  }

  public async isDisabled(): Promise<boolean> {
    return this.elements[0]?.disabled ?? false;
  }

  public async click(): Promise<void> {
    await this.elements[0]?.click?.();
  }
}

function createPage(input: {
  readonly primary?: readonly MockElement[];
  readonly fallback?: readonly MockElement[];
} = {}): Page {
  const summary: MockElement = {
    visible: true,
    descendants: input.fallback ?? [],
  };

  return {
    locator(selector: string): MockLocator {
      if (selector === COMMUNITY_POINTS_CLAIM_BUTTON_SELECTOR) {
        return new MockLocator(input.primary ?? []);
      }
      if (selector === COMMUNITY_POINTS_SUMMARY_SELECTOR) {
        return new MockLocator(
          input.fallback === undefined ? [] : [summary],
        );
      }
      return new MockLocator([]);
    },
  } as unknown as Page;
}

function createLogger(): {
  readonly logger: RewardClaimerLogger;
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const warn = vi.fn();

  return {
    logger: { info, warn },
    info,
    warn,
  };
}

describe('RewardClaimer', () => {
  it('使用 primary selector 點擊可領取按鈕', async () => {
    const click = vi.fn(async () => undefined);
    const onResult = vi.fn();
    const { info, logger } = createLogger();
    const claimer = new RewardClaimer({
      logger,
      clock: () => START_TIME,
      onResult,
    });

    const result = await claimer.claimIfAvailable(
      createPage({ primary: [{ visible: true, click }] }),
      'streamer_one',
    );

    expect(click).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: 'claimed',
      channel: 'streamer_one',
      claimedAt: START_TIME.toISOString(),
    });
    expect(info).toHaveBeenCalledWith(LOG_EVENTS.REWARD_CLAIMED, {
      channel: 'streamer_one',
      claimedAt: START_TIME.toISOString(),
    });
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it('primary selector 不存在時使用 summary 結構 fallback', async () => {
    const click = vi.fn(async () => undefined);
    const claimer = new RewardClaimer({ clock: () => START_TIME });

    const result = await claimer.claimIfAvailable(
      createPage({ fallback: [{ visible: true, click }] }),
      'streamer_two',
    );

    expect(click).toHaveBeenCalledOnce();
    expect(result.status).toBe('claimed');
  });

  it('summary 有多個可點擊元素時不猜測要點擊哪一個', async () => {
    const firstClick = vi.fn(async () => undefined);
    const secondClick = vi.fn(async () => undefined);
    const claimer = new RewardClaimer({ clock: () => START_TIME });

    const result = await claimer.claimIfAvailable(
      createPage({
        fallback: [
          { visible: true, click: firstClick },
          { visible: true, click: secondClick },
        ],
      }),
      'streamer_ambiguous',
    );

    expect(result.status).toBe('not_found');
    expect(firstClick).not.toHaveBeenCalled();
    expect(secondClick).not.toHaveBeenCalled();
  });

  it('primary selector 已存在但 disabled 時不使用 fallback', async () => {
    const primaryClick = vi.fn(async () => undefined);
    const fallbackClick = vi.fn(async () => undefined);
    const claimer = new RewardClaimer({ clock: () => START_TIME });

    const result = await claimer.claimIfAvailable(
      createPage({
        primary: [
          { visible: true, disabled: true, click: primaryClick },
        ],
        fallback: [{ visible: true, click: fallbackClick }],
      }),
      'streamer_three',
    );

    expect(result.status).toBe('not_found');
    expect(primaryClick).not.toHaveBeenCalled();
    expect(fallbackClick).not.toHaveBeenCalled();
  });

  it('按鈕不可見時回傳 not_found', async () => {
    const click = vi.fn(async () => undefined);
    const claimer = new RewardClaimer({ clock: () => START_TIME });

    const result = await claimer.claimIfAvailable(
      createPage({ primary: [{ visible: false, click }] }),
      'streamer_hidden',
    );

    expect(result).toEqual({
      status: 'not_found',
      channel: 'streamer_hidden',
      checkedAt: START_TIME.toISOString(),
    });
    expect(click).not.toHaveBeenCalled();
  });

  it('按鈕不存在時回傳 not_found 且不寫 warn', async () => {
    const { logger, warn } = createLogger();
    const claimer = new RewardClaimer({
      logger,
      clock: () => START_TIME,
    });

    const result = await claimer.claimIfAvailable(
      createPage(),
      'streamer_four',
    );

    expect(result.status).toBe('not_found');
    expect(warn).not.toHaveBeenCalled();
  });

  it('點擊失敗時回傳安全錯誤並記錄 warn', async () => {
    const cookieSecret = 'cookie-secret-value';
    const tokenSecret = 'token-secret-value';
    const click = vi.fn(async () => {
      throw new Error(
        `token=${tokenSecret} Cookie: session=${cookieSecret}`,
      );
    });
    const { logger, warn } = createLogger();
    const onResult = vi.fn();
    const claimer = new RewardClaimer({
      logger,
      clock: () => START_TIME,
      onResult,
    });

    const result = await claimer.claimIfAvailable(
      createPage({ primary: [{ visible: true, click }] }),
      'streamer_five',
    );

    expect(result.status).toBe('click_failed');
    if (result.status !== 'click_failed') {
      throw new Error('Expected click_failed result');
    }
    expect(result.error).toContain(REDACTED_VALUE);
    expect(result.error).not.toContain(cookieSecret);
    expect(result.error).not.toContain(tokenSecret);
    expect(warn).toHaveBeenCalledWith(
      LOG_EVENTS.REWARD_CLAIM_FAILED,
      expect.objectContaining({
        channel: 'streamer_five',
        error: result.error,
      }),
    );
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it('selector API 拋錯時不向外拋出', async () => {
    const selectorSecret = 'selector-token-secret';
    const page = {
      locator(): never {
        throw new Error(`access_token=${selectorSecret}`);
      },
    } as unknown as Page;
    const claimer = new RewardClaimer({ clock: () => START_TIME });

    const result = await claimer.claimIfAvailable(
      page,
      'streamer_six',
    );

    expect(result.status).toBe('click_failed');
    if (result.status === 'click_failed') {
      expect(result.error).not.toContain(selectorSecret);
    }
  });

  it('成功後同一 channel 在 60 秒內不重複點擊', async () => {
    let now = START_TIME.getTime();
    const click = vi.fn(async () => undefined);
    const claimer = new RewardClaimer({
      clock: () => new Date(now),
    });
    const page = createPage({ primary: [{ visible: true, click }] });

    expect(
      (await claimer.claimIfAvailable(page, 'Streamer_Seven')).status,
    ).toBe('claimed');

    now += 59_999;
    expect(
      (await claimer.claimIfAvailable(page, 'streamer_seven')).status,
    ).toBe('not_found');
    expect(click).toHaveBeenCalledOnce();

    now += 1;
    expect(
      (await claimer.claimIfAvailable(page, 'streamer_seven')).status,
    ).toBe('claimed');
    expect(click).toHaveBeenCalledTimes(2);
  });

  it('logger 拋錯時仍回傳領取結果', async () => {
    const logger: RewardClaimerLogger = {
      info(): never {
        throw new Error('logger unavailable');
      },
      warn(): never {
        throw new Error('logger unavailable');
      },
    };
    const claimer = new RewardClaimer({
      logger,
      clock: () => START_TIME,
    });

    const result = await claimer.claimIfAvailable(
      createPage({
        primary: [{ visible: true, click: async () => undefined }],
      }),
      'streamer_eight',
    );

    expect(result.status).toBe('claimed');
  });
});
