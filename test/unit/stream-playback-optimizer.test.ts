import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  DefaultStreamPlaybackOptimizer,
  chooseQuality,
} from '../../src/browser/StreamPlaybackOptimizer.js';

describe('StreamPlaybackOptimizer', () => {
  it('目標畫質不存在時選最低可用畫質', () => {
    expect(chooseQuality(['Auto', '720p', '360p'], '160p')).toBe('360p');
    expect(chooseQuality(['Auto', '160p', '360p'], '360p')).toBe('360p');
    expect(chooseQuality(['Auto', 'Source'], '160p')).toBeUndefined();
  });

  it('靜音並選擇目標畫質', async () => {
    const videoEvaluate = vi.fn(async () => true);
    const settingsClick = vi.fn(async () => undefined);
    const qualityMenuClick = vi.fn(async () => undefined);
    const qualityOptionClick = vi.fn(async () => undefined);
    const page = createPage({
      videoEvaluate,
      settingsClick,
      qualityMenuClick,
      qualityOptionClick,
      qualityLabels: ['Auto', '160p', '360p'],
    });
    const logger = { debug: vi.fn(), info: vi.fn() };
    const optimizer = new DefaultStreamPlaybackOptimizer(
      { muteAudio: true, streamQuality: '160p' },
      logger,
    );

    await expect(optimizer.optimize(page, 'channel')).resolves.toEqual({
      muted: true,
      selectedQuality: '160p',
    });
    expect(videoEvaluate).toHaveBeenCalledOnce();
    expect(settingsClick).toHaveBeenCalledOnce();
    expect(qualityMenuClick).toHaveBeenCalledOnce();
    expect(qualityOptionClick).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      'stream_playback_optimized',
      expect.objectContaining({ selectedQuality: '160p' }),
    );
  });

  it('選畫質時忽略 Picture-in-picture 選項並停用 video PiP', async () => {
    const videoState: {
      muted: boolean;
      volume: number;
      disablePictureInPicture?: boolean;
    } = {
      muted: false,
      volume: 1,
    };
    const clickedIndexes: number[] = [];
    const page = createPage({
      videoEvaluate: vi.fn(async (callback) =>
        callback(videoState)),
      settingsClick: vi.fn(async () => undefined),
      qualityMenuClick: vi.fn(async () => undefined),
      qualityOptionClick: vi.fn(async () => undefined),
      qualityLabels: ['Picture-in-picture', 'Auto', '160p', '360p'],
      qualityOptionIndexesClicked: clickedIndexes,
    });
    const optimizer = new DefaultStreamPlaybackOptimizer(
      { muteAudio: true, streamQuality: '160p' },
      { debug: vi.fn(), info: vi.fn() },
    );

    await expect(optimizer.optimize(page, 'channel')).resolves.toEqual({
      muted: true,
      selectedQuality: '160p',
    });
    expect(videoState).toMatchObject({
      muted: true,
      volume: 0,
      disablePictureInPicture: true,
    });
    expect(clickedIndexes).toEqual([2]);
  });


  it('auto 畫質只靜音，不開啟設定選單', async () => {
    const videoEvaluate = vi.fn(async () => true);
    const settingsClick = vi.fn(async () => undefined);
    const page = createPage({
      videoEvaluate,
      settingsClick,
      qualityMenuClick: vi.fn(async () => undefined),
      qualityOptionClick: vi.fn(async () => undefined),
      qualityLabels: [],
    });
    const optimizer = new DefaultStreamPlaybackOptimizer(
      { muteAudio: true, streamQuality: 'auto' },
      { debug: vi.fn(), info: vi.fn() },
    );

    await expect(optimizer.optimize(page, 'channel')).resolves.toEqual({
      muted: true,
    });
    expect(settingsClick).not.toHaveBeenCalled();
  });

  it('播放器元素不存在時立即略過，不觸發 Playwright 等待', async () => {
    const page = createPage({
      videoEvaluate: vi.fn(async () => true),
      videoCount: 0,
      settingsClick: vi.fn(async () => undefined),
      qualityMenuClick: vi.fn(async () => undefined),
      qualityOptionClick: vi.fn(async () => undefined),
      qualityLabels: [],
    });
    const optimizer = new DefaultStreamPlaybackOptimizer(
      { muteAudio: true, streamQuality: 'auto' },
      { debug: vi.fn(), info: vi.fn() },
    );

    await expect(optimizer.optimize(page, 'channel')).resolves.toEqual({
      muted: false,
    });
  });
});

function createPage(input: {
  readonly videoEvaluate: ReturnType<typeof vi.fn>;
  readonly settingsClick: ReturnType<typeof vi.fn>;
  readonly qualityMenuClick: ReturnType<typeof vi.fn>;
  readonly qualityOptionClick: ReturnType<typeof vi.fn>;
  readonly qualityLabels: readonly string[];
  readonly qualityOptionIndexesClicked?: number[];
  readonly videoCount?: number;
}): Page {
  const firstLocator = (
    visible: boolean,
    click: ReturnType<typeof vi.fn>,
    evaluate?: ReturnType<typeof vi.fn>,
    count = 1,
  ): Locator => {
    const locator = {
      first: () => locator,
      count: vi.fn(async () => count),
      isVisible: vi.fn(async () => visible),
      waitFor: vi.fn(async () => undefined),
      hover: vi.fn(async () => undefined),
      click,
      ...(evaluate === undefined ? {} : { evaluate }),
    };
    return locator as unknown as Locator;
  };
  const firstQualityOption = firstLocator(
    true,
    input.qualityOptionClick,
  );
  const qualityOptions = {
    first: vi.fn(() => firstQualityOption),
    allTextContents: vi.fn(async () => [...input.qualityLabels]),
    nth: vi.fn((index: number) => {
      input.qualityOptionIndexesClicked?.push(index);
      return firstLocator(true, input.qualityOptionClick);
    }),
  } as unknown as Locator;

  return {
    locator(selector: string): Locator {
      if (selector === 'video') {
        return firstLocator(
          true,
          vi.fn(),
          input.videoEvaluate,
          input.videoCount ?? 1,
        );
      }
      if (selector.includes('player-settings-button')) {
        return firstLocator(true, input.settingsClick);
      }
      if (selector.includes('player-settings-menu-item-quality-option')) {
        return qualityOptions;
      }
      return firstLocator(true, input.qualityMenuClick);
    },
    mouse: {
      move: vi.fn(async () => undefined),
    },
  } as unknown as Page;
}
