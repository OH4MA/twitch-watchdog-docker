import type { BrowserContext, Request } from 'playwright';

import { PlaywrightBrowserPageAdapter } from './PlaywrightBrowserPageAdapter.js';
import type {
  BrowserContextAdapter,
  BrowserPageAdapter,
  ResourceBlockingOptions,
} from '../types.js';

const TRACKING_HOSTNAMES = new Set([
  'spade.twitch.tv',
  'science.twitch.tv',
]);

export class PlaywrightBrowserContextAdapter implements BrowserContextAdapter {
  public constructor(private readonly context: BrowserContext) {}

  public async configureResourceBlocking(
    options: ResourceBlockingOptions,
  ): Promise<void> {
    if (
      !options.blockImages &&
      !options.blockFonts &&
      !options.blockKnownTracking
    ) {
      return;
    }
    await this.context.route('**/*', async (route) => {
      if (shouldBlockRequest(route.request(), options)) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
  }

  public async newPage(): Promise<BrowserPageAdapter> {
    const page = await this.context.newPage();
    return new PlaywrightBrowserPageAdapter(page);
  }

  public async close(): Promise<void> {
    await this.context.close();
  }
}

function shouldBlockRequest(
  request: Request,
  options: ResourceBlockingOptions,
): boolean {
  const resourceType = request.resourceType();
  if (options.blockImages && resourceType === 'image') {
    return true;
  }
  if (options.blockFonts && resourceType === 'font') {
    return true;
  }
  if (!options.blockKnownTracking) {
    return false;
  }
  try {
    return TRACKING_HOSTNAMES.has(new URL(request.url()).hostname);
  } catch {
    return false;
  }
}
