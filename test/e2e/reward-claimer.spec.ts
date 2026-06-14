import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import { RewardClaimer } from '../../src/browser/RewardClaimer.js';

function mockPageUrl(fileName: string): string {
  return pathToFileURL(
    resolve(process.cwd(), 'test', 'mock-pages', fileName),
  ).href;
}

test.describe('RewardClaimer mock pages', () => {
  test('primary selector 不依賴按鈕文字', async ({ page }) => {
    await page.goto(mockPageUrl('reward-available.html'));
    const button = page.locator(
      '[data-test-selector="community-points-claim-button"]',
    );
    await expect(button).toHaveText('Reclamar bonificacion');

    const result = await new RewardClaimer().claimIfAvailable(
      page,
      'localized_channel',
    );

    expect(result.status).toBe('claimed');
    await expect(button).toHaveAttribute('data-click-count', '1');
  });

  test('primary selector 缺少時使用 summary 結構 fallback', async ({
    page,
  }) => {
    await page.goto(mockPageUrl('reward-available.html'));
    const button = page.locator(
      '[data-test-selector="community-points-summary"] button',
    );
    await button.evaluate((element) => {
      element.removeAttribute('data-test-selector');
      element.textContent = 'Obtenir le bonus';
    });

    const result = await new RewardClaimer().claimIfAvailable(
      page,
      'fallback_channel',
    );

    expect(result.status).toBe('claimed');
    await expect(button).toHaveAttribute('data-click-count', '1');
  });

  test('disabled 按鈕不會被點擊', async ({ page }) => {
    await page.goto(mockPageUrl('reward-disabled.html'));
    const button = page.locator(
      '[data-test-selector="community-points-claim-button"]',
    );

    const result = await new RewardClaimer().claimIfAvailable(
      page,
      'disabled_channel',
    );

    expect(result.status).toBe('not_found');
    await expect(button).toHaveAttribute('data-click-count', '0');
  });

  test('按鈕不存在時回傳 not_found', async ({ page }) => {
    await page.goto(mockPageUrl('reward-unavailable.html'));

    const result = await new RewardClaimer().claimIfAvailable(
      page,
      'unavailable_channel',
    );

    expect(result.status).toBe('not_found');
  });

  test('真實 locator 點擊失敗時回傳 click_failed', async ({ page }) => {
    await page.goto(mockPageUrl('reward-available.html'));
    await page.setDefaultTimeout(150);
    await page
      .locator('[data-test-selector="community-points-claim-button"]')
      .evaluate((element) => {
        (element as HTMLElement).style.pointerEvents = 'none';
      });

    const result = await new RewardClaimer().claimIfAvailable(
      page,
      'click_failure_channel',
    );

    expect(result.status).toBe('click_failed');
  });

  test('成功後同一 channel 套用 60 秒冷卻', async ({ page }) => {
    await page.goto(mockPageUrl('reward-available.html'));
    const button = page.locator(
      '[data-test-selector="community-points-claim-button"]',
    );
    let now = new Date('2026-06-14T12:00:00.000Z').getTime();
    const claimer = new RewardClaimer({
      clock: () => new Date(now),
    });

    expect(
      (await claimer.claimIfAvailable(page, 'cooldown_channel')).status,
    ).toBe('claimed');

    now += 59_999;
    expect(
      (await claimer.claimIfAvailable(page, 'cooldown_channel')).status,
    ).toBe('not_found');
    await expect(button).toHaveAttribute('data-click-count', '1');

    now += 1;
    expect(
      (await claimer.claimIfAvailable(page, 'cooldown_channel')).status,
    ).toBe('claimed');
    await expect(button).toHaveAttribute('data-click-count', '2');
  });
});
