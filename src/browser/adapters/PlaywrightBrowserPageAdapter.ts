import type { Page } from 'playwright';

import type { BrowserPageAdapter } from '../types.js';

export class PlaywrightBrowserPageAdapter implements BrowserPageAdapter {
  public constructor(public readonly page: Page) {}

  public async close(): Promise<void> {
    if (!this.page.isClosed()) {
      await this.page.close();
    }
  }

  public isClosed(): boolean {
    return this.page.isClosed();
  }

  public onCrash(listener: () => void): () => void {
    this.page.on('crash', listener);
    return () => {
      this.page.off('crash', listener);
    };
  }

  public onClose(listener: () => void): () => void {
    this.page.on('close', listener);
    return () => {
      this.page.off('close', listener);
    };
  }

  public onPopup(listener: (popup: Page) => void): () => void {
    this.page.on('popup', listener);
    return () => {
      this.page.off('popup', listener);
    };
  }
}
