import { afterEach, describe, expect, it, vi } from 'vitest';

import { CgroupV2Reader } from '../../src/app/CgroupV2Reader.js';
import { RuntimeResourceMonitor } from '../../src/app/RuntimeResourceMonitor.js';
import { createDefaultResourceGuard } from '../helpers/test-config.js';
import { mibToBytes } from '../../src/config/resourceGuardThresholds.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('RuntimeResourceMonitor', () => {
  it('啟動時立即記錄 process 欄位，停止後不再排程', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const monitor = new RuntimeResourceMonitor({
      browserManager: {
        getPageCount: () => 2,
        restart: vi.fn(),
      },
      sessionManager: { getActiveChannels: () => ['one', 'two'] },
      logger,
      intervalSeconds: 10,
      resourceGuard: createDefaultResourceGuard(2, { enabled: false }),
      cgroupReader: {
        probe: async () => ({ available: false, reason: 'test' }),
        readSnapshot: async () => {
          throw new Error('should not read');
        },
      } as unknown as CgroupV2Reader,
    });

    await monitor.start();
    expect(logger.info).toHaveBeenCalledWith(
      'runtime_resource_snapshot',
      expect.objectContaining({
        activeChannelCount: 2,
        browserPageCount: 2,
        processRssBytes: expect.any(Number),
        resourceGuardState: 'disabled',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'cgroup_metrics_unavailable',
      expect.objectContaining({ reason: 'test' }),
    );

    await monitor.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    const snapshotCalls = logger.info.mock.calls.filter(
      (call) => call[0] === 'runtime_resource_snapshot',
    );
    expect(snapshotCalls).toHaveLength(1);
  });

  it('cgroup 可用時依政策觸發 browser recycle', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const restart = vi.fn(async () => undefined);
    let sampleIndex = 0;
    const samples = [
      {
        sampledAtMonotonicMs: 0,
        memoryCurrentBytes: mibToBytes(4_700),
        events: { high: 0n, max: 0n, oom: 0n, oomKill: 0n },
      },
      {
        sampledAtMonotonicMs: 2_000,
        memoryCurrentBytes: mibToBytes(4_700),
        events: { high: 0n, max: 0n, oom: 0n, oomKill: 0n },
      },
      {
        sampledAtMonotonicMs: 4_000,
        memoryCurrentBytes: mibToBytes(2_000),
        events: { high: 0n, max: 0n, oom: 0n, oomKill: 0n },
      },
    ];

    const monitor = new RuntimeResourceMonitor({
      browserManager: {
        getPageCount: () => 1,
        restart,
      },
      sessionManager: { getActiveChannels: () => ['one'] },
      logger,
      intervalSeconds: 60,
      resourceGuard: createDefaultResourceGuard(3, {
        scaleWithStreams: false,
      }),
      now: () => samples[Math.min(sampleIndex, samples.length - 1)]!
        .sampledAtMonotonicMs,
      cgroupReader: {
        probe: async () => ({ available: true, rootPath: '/sys/fs/cgroup' }),
        readSnapshot: async () => {
          const current = samples[Math.min(sampleIndex, samples.length - 1)]!;
          sampleIndex += 1;
          return current;
        },
      } as unknown as CgroupV2Reader,
    });

    await monitor.start();
    // First sample is high but only one consecutive → no recycle yet.
    expect(restart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'resource_guard_browser_recycle_requested',
      expect.objectContaining({ reason: 'sustained_high_memory' }),
    );

    await monitor.stop();
  });

  it('runtime snapshot 包含 cgroup CPU 累計時間', async () => {
    const logger = createLogger();
    const monitor = new RuntimeResourceMonitor({
      browserManager: {
        getPageCount: () => 1,
        restart: vi.fn(),
      },
      sessionManager: { getActiveChannels: () => ['one'] },
      logger,
      intervalSeconds: 60,
      cgroupReader: {
        probe: async () => ({ available: true, rootPath: '/sys/fs/cgroup' }),
        readSnapshot: async () => ({
          sampledAtMonotonicMs: 0,
          memoryCurrentBytes: 1_000n,
          cpu: {
            usageUsec: 9_007_199_254_740_992n,
            userUsec: 700n,
            systemUsec: 300n,
          },
          events: { high: 0n, max: 0n, oom: 0n, oomKill: 0n },
        }),
      } as unknown as CgroupV2Reader,
    });

    await monitor.start();

    expect(logger.info).toHaveBeenCalledWith(
      'runtime_resource_snapshot',
      expect.objectContaining({
        cgroupCpuUsageUsec: '9007199254740992',
        cgroupCpuUserUsec: 700,
        cgroupCpuSystemUsec: 300,
      }),
    );
    await monitor.stop();
  });

  it('emergency 時呼叫 container restart handler', async () => {
    const logger = createLogger();
    const onContainerRestartRequested = vi.fn(async () => undefined);
    const monitor = new RuntimeResourceMonitor({
      browserManager: {
        getPageCount: () => 1,
        restart: vi.fn(),
      },
      sessionManager: { getActiveChannels: () => ['one'] },
      logger,
      intervalSeconds: 60,
      resourceGuard: createDefaultResourceGuard(3, {
        scaleWithStreams: false,
      }),
      onContainerRestartRequested,
      cgroupReader: {
        probe: async () => ({ available: true, rootPath: '/sys/fs/cgroup' }),
        readSnapshot: async () => ({
          sampledAtMonotonicMs: 0,
          memoryCurrentBytes: mibToBytes(6_000),
          events: { high: 0n, max: 0n, oom: 0n, oomKill: 0n },
        }),
      } as unknown as CgroupV2Reader,
    });

    await monitor.start();
    expect(onContainerRestartRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'emergency_memory',
        source: 'resource_guard',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'resource_guard_container_restart_requested',
      expect.objectContaining({ reason: 'emergency_memory' }),
    );
    await monitor.stop();
  });
});
