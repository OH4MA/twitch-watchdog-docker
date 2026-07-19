import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  readChannelPointsBalance,
} from '../../src/browser/ChannelPointsReader.js';

function createPage(
  summaries: readonly (readonly string[])[],
  onEvaluateAll = vi.fn(),
): Page {
  return {
    locator: vi.fn(() => ({
      evaluateAll: vi.fn(async () => {
        onEvaluateAll();
        return summaries.map((candidates) => ({
          visible: true,
          candidates,
        }));
      }),
    })),
  } as unknown as Page;
}

describe('readChannelPointsBalance', () => {
  it.each([
    ['1,250', 1_250],
    ['1.250', 1_250],
    ['12 345 678', 12_345_678],
  ])('解析千分位 %s', async (displayValue, balance) => {
    await expect(
      readChannelPointsBalance(createPage([['', displayValue]])),
    ).resolves.toEqual({ status: 'available', balance, displayValue });
  });

  it.each([
    ['1.2K', 1_200],
    ['2,5 M', 2_500_000],
    ['3B', 3_000_000_000],
    ['1.5萬', 15_000],
    ['2,5億', 250_000_000],
    ['3亿', 300_000_000],
  ])('解析縮寫 %s', async (displayValue, balance) => {
    await expect(
      readChannelPointsBalance(createPage([[displayValue]])),
    ).resolves.toEqual({ status: 'available', balance, displayValue });
  });

  it('依序檢查摘要候選值並只執行一次批次 DOM 讀取', async () => {
    const onEvaluateAll = vi.fn();
    const page = createPage([
      ['Bits and Points Balances', '沒有可用餘額'],
      ['Channel Points: 8,765'],
    ], onEvaluateAll);

    await expect(readChannelPointsBalance(page)).resolves.toEqual({
      status: 'available',
      balance: 8_765,
      displayValue: '8,765',
    });
    expect(onEvaluateAll).toHaveBeenCalledOnce();
    expect(page.locator).toHaveBeenCalledOnce();
  });

  it('摘要不存在時回傳 not_found', async () => {
    await expect(
      readChannelPointsBalance(createPage([])),
    ).resolves.toEqual({ status: 'unavailable', reason: 'not_found' });
  });

  it('只存在隱藏摘要時視為 not_found', async () => {
    const page = {
      locator: vi.fn(() => ({
        evaluateAll: vi.fn(async () => [{
          visible: false,
          candidates: ['9,999'],
        }]),
      })),
    } as unknown as Page;

    await expect(readChannelPointsBalance(page)).resolves.toEqual({
      status: 'unavailable',
      reason: 'not_found',
    });
  });

  it('摘要存在但沒有可解析數字時回傳 parse_failed', async () => {
    await expect(
      readChannelPointsBalance(createPage([['Channel Points unavailable']])),
    ).resolves.toEqual({ status: 'unavailable', reason: 'parse_failed' });
  });

  it('DOM 批次讀取失敗時不向外拋出錯誤', async () => {
    const page = {
      locator: vi.fn(() => ({
        evaluateAll: vi.fn(async () => {
          throw new Error('Execution context was destroyed');
        }),
      })),
    } as unknown as Page;

    await expect(readChannelPointsBalance(page)).resolves.toEqual({
      status: 'unavailable',
      reason: 'parse_failed',
    });
  });
});
