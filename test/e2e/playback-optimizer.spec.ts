import { expect, test } from '@playwright/test';

import { DefaultStreamPlaybackOptimizer } from '../../src/browser/StreamPlaybackOptimizer.js';

test('播放器優化器會靜音並選擇最低可用畫質', async ({ page }) => {
  await page.setContent(`
    <video></video>
    <button data-a-target="player-settings-button">Settings</button>
    <button data-a-target="player-settings-menu-item-quality">Quality</button>
    <button data-a-target="player-settings-menu-item-quality-option">Auto</button>
    <button data-a-target="player-settings-menu-item-quality-option">360p</button>
    <script>
      for (const button of document.querySelectorAll(
        '[data-a-target="player-settings-menu-item-quality-option"]',
      )) {
        button.addEventListener('click', () => {
          document.body.dataset.selectedQuality = button.textContent.trim();
        });
      }
    </script>
  `);
  const optimizer = new DefaultStreamPlaybackOptimizer(
    { muteAudio: true, streamQuality: '160p' },
    { debug: () => undefined, info: () => undefined },
  );

  await expect(optimizer.optimize(page, 'test_channel')).resolves.toEqual({
    muted: true,
    selectedQuality: '360p',
  });
  await expect(page.locator('video')).toHaveJSProperty('muted', true);
  await expect(page.locator('body')).toHaveAttribute(
    'data-selected-quality',
    '360p',
  );
});
