import type { Browser } from 'playwright';

import { PlaywrightBrowserContextAdapter } from './PlaywrightBrowserContextAdapter.js';
import type {
  BrowserAdapter,
  BrowserContextAdapter,
  BrowserContextOptions,
} from '../types.js';

export class PlaywrightBrowserAdapter implements BrowserAdapter {
  public constructor(private readonly browser: Browser) {}

  public async newContext(
    options: BrowserContextOptions,
  ): Promise<BrowserContextAdapter> {
    const context = await this.browser.newContext(options);
    return new PlaywrightBrowserContextAdapter(context);
  }

  public async close(): Promise<void> {
    await this.browser.close();
  }

  public onDisconnected(listener: () => void): () => void {
    this.browser.on('disconnected', listener);
    return () => {
      this.browser.off('disconnected', listener);
    };
  }
}
