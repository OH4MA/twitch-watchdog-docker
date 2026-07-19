import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { collapseSideNav } from '../../src/browser/SideNavCollapser.js';

describe('collapseSideNav', () => {
  it('按鈕表示側欄展開時自動收合', async () => {
    const click = vi.fn(async () => undefined);
    const page = createPage({ ariaLabel: 'Collapse Side Nav', click });

    await expect(collapseSideNav(page)).resolves.toBe('collapsed');
    expect(click).toHaveBeenCalledOnce();
  });

  it('aria-expanded 為 false 時不重複點擊', async () => {
    const click = vi.fn(async () => undefined);
    const page = createPage({ ariaExpanded: 'false', click });

    await expect(collapseSideNav(page)).resolves.toBe(
      'already_collapsed',
    );
    expect(click).not.toHaveBeenCalled();
  });

  it('缺少按鈕時安全略過', async () => {
    const page = createPage({ visible: false });

    await expect(collapseSideNav(page)).resolves.toBe('not_found');
  });

  it('按鈕點擊失敗時不向外拋錯', async () => {
    const page = createPage({
      ariaLabel: 'Collapse Side Nav',
      click: vi.fn(async () => {
        throw new Error('detached');
      }),
    });

    await expect(collapseSideNav(page)).resolves.toBe('failed');
  });
});

function createPage(input: {
  readonly visible?: boolean;
  readonly ariaExpanded?: string;
  readonly ariaLabel?: string;
  readonly click?: ReturnType<typeof vi.fn>;
}): Page {
  const element = {
    getAttribute(name: string): string | null {
      if (name === 'aria-expanded') {
        return input.ariaExpanded ?? null;
      }
      if (name === 'aria-label') {
        return input.ariaLabel ?? null;
      }
      return null;
    },
    closest(): null {
      return null;
    },
  };
  const locator = {
    first: () => locator,
    waitFor: vi.fn(async () => {
      if (input.visible === false) {
        throw new Error('not visible');
      }
    }),
    evaluate: vi.fn(async (callback, options) =>
      callback(element, options)),
    click: input.click ?? vi.fn(async () => undefined),
  } as unknown as Locator;
  return {
    locator: vi.fn(() => locator),
  } as unknown as Page;
}
