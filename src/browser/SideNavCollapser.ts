import type { Page } from 'playwright';

export const SIDE_NAV_TOGGLE_SELECTOR =
  'button[data-a-target="side-nav-arrow"]';

const SIDE_NAV_SELECTOR = '[data-a-target="side-nav-bar"]';
const SIDE_NAV_WAIT_TIMEOUT_MS = 2_000;
const EXPANDED_SIDE_NAV_MIN_WIDTH_PX = 100;

export type SideNavCollapseResult =
  | 'collapsed'
  | 'already_collapsed'
  | 'not_found'
  | 'failed';

export async function collapseSideNav(
  page: Page,
): Promise<SideNavCollapseResult> {
  const toggle = page.locator(SIDE_NAV_TOGGLE_SELECTOR).first();
  try {
    await toggle.waitFor({
      state: 'visible',
      timeout: SIDE_NAV_WAIT_TIMEOUT_MS,
    });
  } catch {
    return 'not_found';
  }

  try {
    const expanded = await toggle.evaluate(
      (element, options) => {
        const browserGlobal = globalThis as unknown as {
          readonly document: {
            querySelector(selector: string): {
              getBoundingClientRect(): { readonly width: number };
            } | null;
          };
        };
        const ariaExpanded = element.getAttribute('aria-expanded');
        if (ariaExpanded !== null) {
          return ariaExpanded === 'true';
        }

        const accessibleLabel = [
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ]
          .filter((value): value is string => value !== null)
          .join(' ')
          .toLocaleLowerCase('en-US');
        if (/collapse|收合|折疊|折叠|縮小|缩小/u.test(accessibleLabel)) {
          return true;
        }
        if (/expand|展開|展开/u.test(accessibleLabel)) {
          return false;
        }

        const sideNav =
          element.closest('nav') ??
          browserGlobal.document.querySelector(options.sideNavSelector);
        return (
          sideNav !== null &&
          sideNav.getBoundingClientRect().width >= options.expandedMinWidthPx
        );
      },
      {
        sideNavSelector: SIDE_NAV_SELECTOR,
        expandedMinWidthPx: EXPANDED_SIDE_NAV_MIN_WIDTH_PX,
      },
    );
    if (!expanded) {
      return 'already_collapsed';
    }

    await toggle.click({ timeout: SIDE_NAV_WAIT_TIMEOUT_MS });
    return 'collapsed';
  } catch {
    return 'failed';
  }
}
