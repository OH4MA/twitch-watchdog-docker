import type { Page } from 'playwright';

export const COMMUNITY_POINTS_BALANCE_SELECTOR =
  '[data-test-selector="community-points-summary"]';

const BALANCE_PATTERN =
  /(?:\d{1,3}(?:(?:[.,]|\s)\d{3})+|\d+(?:[.,]\d+)?)\s*(?:K|M|B|萬|億|亿)?/giu;

const BALANCE_MULTIPLIERS: Readonly<Record<string, number>> = {
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
  '萬': 10_000,
  '億': 100_000_000,
  '亿': 100_000_000,
};

export type ChannelPointsReadResult =
  | {
      status: 'available';
      balance: number;
      displayValue: string;
    }
  | {
      status: 'unavailable';
      reason: 'not_found' | 'parse_failed';
    };

interface ChannelPointsSummarySnapshot {
  readonly visible: boolean;
  readonly candidates: readonly string[];
}

export async function readChannelPointsBalance(
  page: Page,
): Promise<ChannelPointsReadResult> {
  let summaries: readonly ChannelPointsSummarySnapshot[];
  try {
    summaries = await page
      .locator(COMMUNITY_POINTS_BALANCE_SELECTOR)
      .evaluateAll((elements) => {
        const browserGlobal = globalThis as unknown as {
          getComputedStyle(element: unknown): {
            readonly display: string;
            readonly visibility: string;
          };
        };
        return elements.map((element) => {
          const style = browserGlobal.getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          return {
            visible:
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              ((bounds.width > 0 && bounds.height > 0) ||
                element.getClientRects().length > 0),
            candidates: [
              element.querySelector(
                '[data-test-selector="balance-string"]',
              )?.textContent ?? null,
              element.getAttribute('aria-label'),
              element.getAttribute('title'),
              element.textContent,
            ].filter((value): value is string => value !== null),
          };
        });
      });
  } catch {
    return { status: 'unavailable', reason: 'parse_failed' };
  }

  const visibleSummaries = summaries.filter((summary) => summary.visible);
  if (visibleSummaries.length === 0) {
    return { status: 'unavailable', reason: 'not_found' };
  }

  for (const summary of visibleSummaries) {
    for (const candidate of summary.candidates) {
      const parsed = parseBalance(candidate);
      if (parsed !== null) {
        return {
          status: 'available',
          balance: parsed.balance,
          displayValue: parsed.displayValue,
        };
      }
    }
  }

  return { status: 'unavailable', reason: 'parse_failed' };
}

function parseBalance(
  value: string,
): { readonly balance: number; readonly displayValue: string } | null {
  const normalizedValue = value
    .replace(/[\u00a0\u202f]/gu, ' ')
    .trim();
  const matches = normalizedValue.matchAll(BALANCE_PATTERN);

  for (const match of matches) {
    const displayValue = match[0].trim();
    const suffixMatch = displayValue.match(/(K|M|B|萬|億|亿)$/iu);
    const suffix = suffixMatch?.[1] ?? '';
    const numericText = suffix === ''
      ? displayValue
      : displayValue.slice(0, -suffix.length).trim();
    const numericValue = parseLocalizedNumber(numericText, suffix !== '');
    if (numericValue === null) {
      continue;
    }

    const multiplier = suffix === ''
      ? 1
      : BALANCE_MULTIPLIERS[suffix.toLocaleUpperCase('en-US')];
    if (multiplier === undefined) {
      continue;
    }

    const balance = Math.round(numericValue * multiplier);
    if (Number.isSafeInteger(balance) && balance >= 0) {
      return { balance, displayValue };
    }
  }

  return null;
}

function parseLocalizedNumber(
  value: string,
  allowDecimal: boolean,
): number | null {
  const compact = value.replace(/\s/gu, '');
  if (/^\d+$/u.test(compact)) {
    return Number(compact);
  }

  const groups = compact.split(/[.,]/u);
  if (
    groups.length > 1 &&
    groups[0] !== undefined &&
    /^\d{1,3}$/u.test(groups[0]) &&
    groups.slice(1).every((group) => /^\d{3}$/u.test(group))
  ) {
    return Number(groups.join(''));
  }

  if (
    allowDecimal &&
    groups.length === 2 &&
    groups[0] !== undefined &&
    groups[1] !== undefined &&
    /^\d+$/u.test(groups[0]) &&
    /^\d+$/u.test(groups[1])
  ) {
    return Number(`${groups[0]}.${groups[1]}`);
  }

  return null;
}
