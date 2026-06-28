export const CHANNEL_PATTERN = /^[A-Za-z0-9_]{1,25}$/u;

export function createChannelUrl(channel: string): string {
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error('Channel 必須是 1 到 25 字元的英數字或底線');
  }
  return `https://www.twitch.tv/${encodeURIComponent(channel)}`;
}

export function isExpectedChannelUrl(
  currentUrl: string,
  targetUrl: string,
): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return (
      current.origin.toLocaleLowerCase('en-US') ===
        target.origin.toLocaleLowerCase('en-US') &&
      normalizePath(current.pathname) === normalizePath(target.pathname)
    );
  } catch {
    return false;
  }
}

export function stableJitter(value: string, maximumMs: number): number {
  if (!Number.isSafeInteger(maximumMs) || maximumMs <= 0) {
    return 0;
  }
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % maximumMs;
}

function normalizePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/u, '') || '/';
  return normalized.toLocaleLowerCase('en-US');
}
