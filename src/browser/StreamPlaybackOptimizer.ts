import type { Page } from 'playwright';

import type { BrowserConfig } from '../config/index.js';
import type { LogFields, Logger } from '../logging/index.js';

const SETTINGS_BUTTON_SELECTOR =
  'button[data-a-target="player-settings-button"]';
const QUALITY_MENU_SELECTOR =
  '[data-a-target="player-settings-menu-item-quality"]';
const QUALITY_OPTION_SELECTOR =
  [
    '[data-a-target="player-settings-menu-item-quality-option"]',
    '[role="menuitemradio"]',
  ].join(', ');
const QUALITY_ORDER = ['160p', '360p', '480p'] as const;
const CONTROL_WAIT_TIMEOUT_MS = 2_000;

export interface PlaybackOptimizationResult {
  readonly muted: boolean;
  readonly selectedQuality?: string;
}

export interface StreamPlaybackOptimizer {
  optimize(page: Page, channel: string): Promise<PlaybackOptimizationResult>;
}

export type StreamPlaybackOptimizerLogger = Pick<Logger, 'debug' | 'info'>;

export class DefaultStreamPlaybackOptimizer
implements StreamPlaybackOptimizer {
  public constructor(
    private readonly config: Pick<
      BrowserConfig,
      'muteAudio' | 'streamQuality'
    >,
    private readonly logger: StreamPlaybackOptimizerLogger,
  ) {}

  public async optimize(
    page: Page,
    channel: string,
  ): Promise<PlaybackOptimizationResult> {
    const muted = this.config.muteAudio
      ? await this.muteVideo(page, channel)
      : false;
    if (this.config.streamQuality === 'auto') {
      return { muted };
    }

    const selectedQuality = await this.selectQuality(
      page,
      channel,
      this.config.streamQuality,
    );
    if (selectedQuality !== undefined) {
      safeLog(this.logger, 'info', 'stream_playback_optimized', {
        channel,
        muted,
        selectedQuality,
      });
    }
    return {
      muted,
      ...(selectedQuality === undefined ? {} : { selectedQuality }),
    };
  }

  private async muteVideo(page: Page, channel: string): Promise<boolean> {
    try {
      const video = page.locator('video').first();
      if ((await video.count()) === 0) {
        return false;
      }
      return await video.evaluate((element) => {
        const video = element as unknown as {
          muted: boolean;
          volume: number;
          disablePictureInPicture?: boolean;
        };
        video.muted = true;
        video.volume = 0;
        video.disablePictureInPicture = true;
        return video.muted && video.volume === 0;
      });
    } catch (error: unknown) {
      safeLog(this.logger, 'debug', 'stream_mute_skipped', {
        channel,
        error: safeErrorMessage(error),
      });
      return false;
    }
  }

  private async selectQuality(
    page: Page,
    channel: string,
    requestedQuality: Exclude<BrowserConfig['streamQuality'], 'auto'>,
  ): Promise<string | undefined> {
    try {
      await this.revealPlayerControls(page);
      const settingsButton = page.locator(SETTINGS_BUTTON_SELECTOR).first();
      if (
        !(await waitForVisible(
          settingsButton,
          CONTROL_WAIT_TIMEOUT_MS,
        ))
      ) {
        this.logQualitySkipped(channel, requestedQuality, 'settings_missing');
        return undefined;
      }
      await settingsButton.click({ timeout: CONTROL_WAIT_TIMEOUT_MS });

      const qualityMenu = page.locator(QUALITY_MENU_SELECTOR).first();
      if (
        !(await waitForVisible(
          qualityMenu,
          CONTROL_WAIT_TIMEOUT_MS,
        ))
      ) {
        this.logQualitySkipped(
          channel,
          requestedQuality,
          'quality_menu_missing',
        );
        return undefined;
      }
      await qualityMenu.click({
        force: true,
        timeout: CONTROL_WAIT_TIMEOUT_MS,
      });

      const options = page.locator(QUALITY_OPTION_SELECTOR);
      if (
        !(await waitForVisible(
          options.first(),
          CONTROL_WAIT_TIMEOUT_MS,
        ))
      ) {
        this.logQualitySkipped(
          channel,
          requestedQuality,
          'quality_options_missing',
        );
        return undefined;
      }
      const labels = (await options.allTextContents()).map((label) =>
        label.trim(),
      );
      const qualityCandidates = qualityOptionCandidates(labels);
      const selectedQuality = chooseQuality(
        qualityCandidates.map((candidate) => candidate.label),
        requestedQuality,
      );
      if (selectedQuality === undefined) {
        this.logQualitySkipped(
          channel,
          requestedQuality,
          'supported_quality_missing',
        );
        return undefined;
      }
      const option = qualityCandidates.find((candidate) =>
        candidate.label.toLocaleLowerCase('en-US').includes(
          selectedQuality.toLocaleLowerCase('en-US'),
        ),
      );
      if (option === undefined) {
        this.logQualitySkipped(
          channel,
          requestedQuality,
          'quality_option_index_missing',
        );
        return undefined;
      }
      await options.nth(option.index).click({
        force: true,
        timeout: CONTROL_WAIT_TIMEOUT_MS,
      });
      return selectedQuality;
    } catch (error: unknown) {
      safeLog(this.logger, 'debug', 'stream_quality_skipped', {
        channel,
        requestedQuality,
        error: safeErrorMessage(error),
      });
      return undefined;
    }
  }

  private logQualitySkipped(
    channel: string,
    requestedQuality: Exclude<BrowserConfig['streamQuality'], 'auto'>,
    reason: string,
  ): void {
    safeLog(this.logger, 'debug', 'stream_quality_skipped', {
      channel,
      requestedQuality,
      reason,
    });
  }

  private async revealPlayerControls(page: Page): Promise<void> {
    const player = page
      .locator('[data-a-target="video-player"], video')
      .first();
    try {
      if ((await player.count()) > 0) {
        await player.hover({ timeout: CONTROL_WAIT_TIMEOUT_MS });
        return;
      }
    } catch {
      // Fall back to moving the pointer inside the compact viewport.
    }
    await page.mouse.move(320, 320);
  }
}

function qualityOptionCandidates(
  labels: readonly string[],
): readonly { readonly index: number; readonly label: string }[] {
  return labels.flatMap((label, index) => {
    if (!isQualityLabel(label)) {
      return [];
    }
    return [{ index, label }];
  });
}

function isQualityLabel(label: string): boolean {
  const normalized = label.trim().toLocaleLowerCase('en-US');
  if (normalized === '') {
    return false;
  }
  if (
    normalized.includes('picture-in-picture') ||
    normalized.includes('picture in picture')
  ) {
    return false;
  }
  return (
    normalized === 'auto' ||
    normalized.includes('source') ||
    /\b\d{3,4}p\b/u.test(normalized)
  );
}

export function chooseQuality(
  labels: readonly string[],
  requestedQuality: Exclude<BrowserConfig['streamQuality'], 'auto'>,
): string | undefined {
  const normalized = labels.map((label) =>
    label.toLocaleLowerCase('en-US'),
  );
  const requested = requestedQuality.toLocaleLowerCase('en-US');
  if (normalized.some((label) => label.includes(requested))) {
    return requestedQuality;
  }
  return QUALITY_ORDER.find((quality) =>
    normalized.some((label) =>
      label.includes(quality.toLocaleLowerCase('en-US')),
    ),
  );
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForVisible(
  locator: ReturnType<Page['locator']>,
  timeout: number,
): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

function safeLog(
  logger: StreamPlaybackOptimizerLogger,
  level: 'debug' | 'info',
  event: string,
  fields: LogFields,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Playback optimization must not interrupt watching.
  }
}
