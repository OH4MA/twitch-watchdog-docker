import { pathToFileURL } from 'node:url';

import {
  createApplication,
  installProcessHandlers,
} from './app/index.js';
import { DEFAULT_CONFIG_PATH } from './config/index.js';
import { createLogger } from './logging/index.js';

export async function main(): Promise<void> {
  const bootstrapLogger = createLogger({ level: 'info' });
  const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  const app = createApplication({
    configPath,
    env: process.env,
    bootstrapLogger,
  });

  installProcessHandlers({ app, logger: bootstrapLogger });

  try {
    await app.start();
  } catch {
    process.exitCode = 1;
  }
}

function isMainModule(moduleUrl: string, entryPath: string | undefined): boolean {
  return (
    entryPath !== undefined &&
    moduleUrl === pathToFileURL(entryPath).href
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  void main();
}
