import { firefox } from 'playwright';

import { PlaywrightBrowserAdapter } from './PlaywrightBrowserAdapter.js';
import type {
  BrowserAdapter,
  BrowserLaunchOptions,
  BrowserLauncher,
} from '../types.js';

export class PlaywrightBrowserLauncher implements BrowserLauncher {
  public async launch(options: BrowserLaunchOptions): Promise<BrowserAdapter> {
    const browser = await firefox.launch(options);
    return new PlaywrightBrowserAdapter(browser);
  }
}
