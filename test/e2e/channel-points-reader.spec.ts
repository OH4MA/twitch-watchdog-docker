import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  readChannelPointsBalance,
} from '../../src/browser/ChannelPointsReader.js';

function mockPageUrl(fileName: string): string {
  return pathToFileURL(
    resolve(process.cwd(), 'test', 'mock-pages', fileName),
  ).href;
}

test.describe('ChannelPointsReader mock pages', () => {
  test('從真實 community points DOM 讀取千分位餘額', async ({ page }) => {
    await page.goto(mockPageUrl('channel-points-available.html'));

    await expect(readChannelPointsBalance(page)).resolves.toEqual({
      status: 'available',
      balance: 12_345,
      displayValue: '12,345',
    });
  });

  test('支援本地化縮寫', async ({ page }) => {
    await page.goto(mockPageUrl('channel-points-available.html'));
    await page
      .locator('[data-test-selector="balance-string"]')
      .evaluate((element) => {
        element.textContent = '2,5萬';
      });

    await expect(readChannelPointsBalance(page)).resolves.toEqual({
      status: 'available',
      balance: 25_000,
      displayValue: '2,5萬',
    });
  });

  test('community points summary 不存在時回傳 not_found', async ({
    page,
  }) => {
    await page.goto(mockPageUrl('channel-points-unavailable.html'));

    await expect(readChannelPointsBalance(page)).resolves.toEqual({
      status: 'unavailable',
      reason: 'not_found',
    });
  });

  test('summary 存在但無數值時回傳 parse_failed', async ({ page }) => {
    await page.goto(mockPageUrl('channel-points-available.html'));
    await page
      .locator('[data-test-selector="community-points-summary"]')
      .evaluate((element) => {
        element.removeAttribute('aria-label');
        element.textContent = 'Channel Points unavailable';
      });

    await expect(readChannelPointsBalance(page)).resolves.toEqual({
      status: 'unavailable',
      reason: 'parse_failed',
    });
  });
});
