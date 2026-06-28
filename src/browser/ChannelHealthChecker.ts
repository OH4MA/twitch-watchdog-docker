import type { Locator, Page } from 'playwright';

import { isExpectedChannelUrl } from './channel-url.js';
import { safeErrorMessage } from './safe-logging.js';

const CONTENT_WARNING_SETTLE_TIMEOUT_MS = 3_000;

export const CHANNEL_HEALTH_SELECTORS = Object.freeze({
  loginRequired: [
    '[data-test-selector="login-required"]',
    '[data-a-target="login-button"]',
    '[data-channel-health="login-required"]',
  ].join(', '),
  liveContent: [
    'video',
    '[data-a-target="video-player"]',
    '[data-test-selector="video-player"]',
    '[data-channel-health="live"]',
  ].join(', '),
  error: [
    '[data-test-selector="error-page"]',
    '[data-a-target="player-error-message"]',
    '[data-channel-health="error"]',
  ].join(', '),
  offline: [
    '[data-test-selector="offline-page"]',
    '[data-a-target="offline-channel-main-content"]',
    '[data-channel-health="offline"]',
  ].join(', '),
  contentWarning: [
    '[data-a-target="content-classification-gate-overlay-start-watching-button"]',
    '[data-a-target="content-warning-start-watching-button"]',
    '[data-channel-health="content-warning"]',
    'button:has-text("Start Watching")',
    'button:has-text("開始觀看")',
  ].join(', '),
});

export type ChannelHealthFailureReason =
  | 'not_started'
  | 'page_closed'
  | 'url_mismatch'
  | 'login_required'
  | 'error_page'
  | 'offline'
  | 'content_warning'
  | 'live_content_missing'
  | 'health_check_error';

export type ChannelHealthResult =
  | { readonly healthy: true; readonly reason: 'live' }
  | {
      readonly healthy: false;
      readonly reason: ChannelHealthFailureReason;
      readonly error?: string;
    };

export type ChannelHealthEvaluator = (
  page: Page,
  targetUrl: string,
) => Promise<ChannelHealthResult>;

export type ContentWarningAcceptResult =
  | 'not_present'
  | 'accepted'
  | 'blocked';

export async function evaluateChannelHealth(
  page: Page,
  targetUrl: string,
): Promise<ChannelHealthResult> {
  try {
    if (page.isClosed()) {
      return { healthy: false, reason: 'page_closed' };
    }

    if (!isExpectedChannelUrl(page.url(), targetUrl)) {
      return { healthy: false, reason: 'url_mismatch' };
    }

    if (
      await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.error)) ||
      await hasUnsupportedPlayerError(page)
    ) {
      return { healthy: false, reason: 'error_page' };
    }

    if (await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.offline))) {
      return { healthy: false, reason: 'offline' };
    }

    const contentWarningResult = await acceptContentWarning(page);
    if (
      contentWarningResult === 'accepted' &&
      await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.liveContent))
    ) {
      return { healthy: true, reason: 'live' };
    }
    if (contentWarningResult !== 'not_present') {
      return { healthy: false, reason: 'content_warning' };
    }

    if (
      await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.liveContent))
    ) {
      return { healthy: true, reason: 'live' };
    }

    if (
      await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.loginRequired))
    ) {
      return { healthy: false, reason: 'login_required' };
    }

    return { healthy: false, reason: 'live_content_missing' };
  } catch (error: unknown) {
    return {
      healthy: false,
      reason: 'health_check_error',
      error: safeErrorMessage(error),
    };
  }
}

export async function acceptContentWarning(
  page: Page,
): Promise<ContentWarningAcceptResult> {
  const button = page.locator(CHANNEL_HEALTH_SELECTORS.contentWarning).first();
  if (!(await isVisible(button))) {
    return 'not_present';
  }

  try {
    await button.click({ timeout: CONTENT_WARNING_SETTLE_TIMEOUT_MS });
    await page
      .locator(CHANNEL_HEALTH_SELECTORS.liveContent)
      .first()
      .waitFor({
        state: 'visible',
        timeout: CONTENT_WARNING_SETTLE_TIMEOUT_MS,
      })
      .catch(() => undefined);
    return 'accepted';
  } catch {
    return 'blocked';
  }
}

async function isVisible(locator: Locator): Promise<boolean> {
  const count = Math.min(await locator.count(), 10);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) {
      return true;
    }
  }
  return false;
}

async function hasUnsupportedPlayerError(page: Page): Promise<boolean> {
  try {
    const playerText = (
      await page
      .locator(
        [
          '[data-a-target="player-error-message"]',
          '[data-test-selector="video-player"]',
          '[data-a-target="video-player"]',
        ].join(', '),
      )
        .allTextContents()
    ).join(' ');
    return (
      /This video is either unavailable or not supported in this browser/iu
        .test(playerText) ||
      /Error\s*#4000/iu.test(playerText)
    );
  } catch {
    return false;
  }
}
