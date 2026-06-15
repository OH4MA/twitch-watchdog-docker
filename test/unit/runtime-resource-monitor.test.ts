import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeResourceMonitor } from '../../src/app/RuntimeResourceMonitor.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RuntimeResourceMonitor', () => {
  it('啟動時立即記錄並依週期採樣，停止後清除 timer', async () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const monitor = new RuntimeResourceMonitor({
      browserManager: { getPageCount: () => 2 },
      sessionManager: { getActiveChannels: () => ['one', 'two'] },
      logger: { info },
      intervalSeconds: 10,
    });

    await monitor.start();
    expect(info).toHaveBeenCalledWith(
      'runtime_resource_snapshot',
      expect.objectContaining({
        activeChannelCount: 2,
        browserPageCount: 2,
        processRssBytes: expect.any(Number),
      }),
    );

    vi.advanceTimersByTime(10_000);
    expect(info).toHaveBeenCalledTimes(2);

    await monitor.stop();
    vi.advanceTimersByTime(20_000);
    expect(info).toHaveBeenCalledTimes(2);
  });
});
