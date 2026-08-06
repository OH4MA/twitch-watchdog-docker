import { expect, test } from '@playwright/test';

import {
  CHAT_WEBSOCKET_BLOCK_SCRIPT,
  CHAT_WEBSOCKET_HOSTNAME,
} from '../../src/browser/ChatDisabler.js';

test('chat WebSocket is replaced by a silent fake socket', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(CHAT_WEBSOCKET_BLOCK_SCRIPT);
  const page = await context.newPage();
  await page.goto('about:blank');

  const result = await page.evaluate((host) => {
    const socket = new WebSocket(`wss://${host}/`);
    return new Promise<{ opened: boolean; readyState: number }>((resolve) => {
      socket.onopen = () => {
        socket.send('PING');
        socket.close();
        resolve({ opened: true, readyState: socket.readyState });
      };
      setTimeout(() => resolve({ opened: false, readyState: -1 }), 2000);
    });
  }, CHAT_WEBSOCKET_HOSTNAME);

  expect(result.opened).toBe(true);
  await context.close();
});

test('non-chat WebSocket URLs use the real constructor', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(CHAT_WEBSOCKET_BLOCK_SCRIPT);
  const page = await context.newPage();
  await page.goto('about:blank');

  const isPatchedForOtherHost = await page.evaluate(() => {
    const socket = new WebSocket('wss://example.invalid/');
    return socket instanceof WebSocket && socket.url === 'wss://example.invalid/';
  });

  expect(isPatchedForOtherHost).toBe(true);
  await context.close();
});
