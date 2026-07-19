import { describe, expect, it } from 'vitest';

import type { CgroupSnapshot } from '../../src/app/CgroupV2Reader.js';
import { ResourceGuardPolicy } from '../../src/app/ResourceGuardPolicy.js';
import { mibToBytes } from '../../src/config/resourceGuardThresholds.js';

function snapshot(input: {
  readonly atMs: number;
  readonly memoryMib: number;
  readonly swapMib?: number;
  readonly high?: bigint;
  readonly max?: bigint;
  readonly oom?: bigint;
  readonly oomKill?: bigint;
}): CgroupSnapshot {
  return {
    sampledAtMonotonicMs: input.atMs,
    memoryCurrentBytes: mibToBytes(input.memoryMib),
    ...(input.swapMib === undefined
      ? {}
      : { swapCurrentBytes: mibToBytes(input.swapMib) }),
    events: {
      high: input.high ?? 0n,
      max: input.max ?? 0n,
      oom: input.oom ?? 0n,
      oomKill: input.oomKill ?? 0n,
    },
  };
}

function createPolicy(now: () => number = () => 0): ResourceGuardPolicy {
  return new ResourceGuardPolicy({
    now,
    config: {
      sampleIntervalSeconds: 2,
      startupRateGraceSeconds: 120,
      browserRecycleConsecutiveSamples: 2,
      emergencySwapMib: 768,
      fastGrowthMib: 1_024,
      fastGrowthWindowSeconds: 30,
      postBrowserRestartRateGraceSeconds: 120,
      postRecycleObservationSeconds: 20,
      postRecycleMinimumDropMib: 512,
      effective: {
        maxConcurrentStreams: 3,
        warningMemoryMib: 4_096,
        warningResetMemoryMib: 3_840,
        browserRecycleMemoryMib: 4_608,
        emergencyMemoryMib: 5_376,
        postRecycleTargetMemoryMib: 4_096,
      },
    },
  });
}

describe('ResourceGuardPolicy', () => {
  it('低於門檻時不動作', () => {
    const policy = createPolicy();
    expect(policy.evaluate(snapshot({ atMs: 0, memoryMib: 1_000 }))).toEqual({
      action: 'none',
    });
  });

  it('warning 只觸發一次，降到 reset 以下才解除', () => {
    const policy = createPolicy();
    expect(policy.evaluate(snapshot({ atMs: 0, memoryMib: 4_100 }))).toEqual({
      action: 'warn',
      reason: 'memory_warning',
    });
    expect(policy.evaluate(snapshot({ atMs: 2_000, memoryMib: 4_100 }))).toEqual(
      { action: 'none' },
    );
    expect(policy.evaluate(snapshot({ atMs: 4_000, memoryMib: 3_900 }))).toEqual(
      { action: 'none' },
    );
    // Still above reset (3840).
    expect(policy.evaluate(snapshot({ atMs: 6_000, memoryMib: 4_100 }))).toEqual(
      { action: 'none' },
    );
    expect(policy.evaluate(snapshot({ atMs: 8_000, memoryMib: 3_000 }))).toEqual(
      { action: 'none' },
    );
    expect(policy.evaluate(snapshot({ atMs: 10_000, memoryMib: 4_100 }))).toEqual(
      {
        action: 'warn',
        reason: 'memory_warning',
      },
    );
  });

  it('需連續兩個高水位 sample 才 recycle', () => {
    const policy = createPolicy();
    // First high sample also crosses warning; recycle still needs two samples.
    expect(policy.evaluate(snapshot({ atMs: 0, memoryMib: 4_700 }))).toEqual({
      action: 'warn',
      reason: 'memory_warning',
    });
    expect(policy.evaluate(snapshot({ atMs: 2_000, memoryMib: 4_700 }))).toEqual({
      action: 'recycle_browser',
      reason: 'sustained_high_memory',
    });
  });

  it('emergency memory 優先於 recycle', () => {
    const policy = createPolicy();
    expect(policy.evaluate(snapshot({ atMs: 0, memoryMib: 5_500 }))).toEqual({
      action: 'restart_container',
      reason: 'emergency_memory',
    });
  });

  it('swap emergency 立即重啟容器', () => {
    const policy = createPolicy();
    expect(
      policy.evaluate(snapshot({ atMs: 0, memoryMib: 1_000, swapMib: 800 })),
    ).toEqual({
      action: 'restart_container',
      reason: 'emergency_swap',
    });
  });

  it('oom / max event 上升觸發 container restart', () => {
    const policy = createPolicy();
    expect(
      policy.evaluate(snapshot({ atMs: 0, memoryMib: 1_000, oom: 0n, max: 0n })),
    ).toEqual({ action: 'none' });
    expect(
      policy.evaluate(snapshot({ atMs: 2_000, memoryMib: 1_000, oom: 1n })),
    ).toEqual({
      action: 'restart_container',
      reason: 'cgroup_oom',
    });

    const policyMax = createPolicy();
    policyMax.evaluate(snapshot({ atMs: 0, memoryMib: 1_000, max: 0n }));
    expect(
      policyMax.evaluate(snapshot({ atMs: 2_000, memoryMib: 1_000, max: 1n })),
    ).toEqual({
      action: 'restart_container',
      reason: 'cgroup_memory_max',
    });
  });

  it('emergency-only 模式略過 recycle/warning，但仍偵測 OOM', () => {
    const policy = createPolicy();
    policy.evaluate(snapshot({ atMs: 0, memoryMib: 4_700, oom: 0n }));

    expect(
      policy.evaluateEmergencyOnly(
        snapshot({ atMs: 2_000, memoryMib: 4_700, oom: 0n }),
      ),
    ).toEqual({ action: 'none' });
    expect(
      policy.evaluateEmergencyOnly(
        snapshot({ atMs: 4_000, memoryMib: 4_700, oom: 1n }),
      ),
    ).toEqual({
      action: 'restart_container',
      reason: 'cgroup_oom',
    });
  });

  it('啟動 grace 期間忽略 fast growth，之後在 warning 以上才觸發', () => {
    let now = 0;
    const policy = createPolicy(() => now);

    policy.evaluate(snapshot({ atMs: 0, memoryMib: 1_000 }));
    now = 8_000;
    expect(policy.evaluate(snapshot({ atMs: 8_000, memoryMib: 2_000 }))).toEqual({
      action: 'none',
    });

    // After startup grace: growth is large but absolute level stays below warning.
    now = 120_000;
    policy.evaluate(snapshot({ atMs: 120_000, memoryMib: 1_000 }));
    now = 150_000;
    expect(
      policy.evaluate(snapshot({ atMs: 150_000, memoryMib: 2_100 })),
    ).toEqual({ action: 'none' });

    // Same rate of growth, but only fatal when already at/above warning.
    now = 160_000;
    policy.evaluate(snapshot({ atMs: 160_000, memoryMib: 4_100 }));
    now = 190_000;
    expect(
      policy.evaluate(snapshot({ atMs: 190_000, memoryMib: 5_200 })),
    ).toEqual({
      action: 'restart_container',
      reason: 'fast_memory_growth',
    });
  });

  it('browser restart 後清除 sample history 並套用 rate grace', () => {
    let now = 0;
    const policy = createPolicy(() => now);

    now = 120_000;
    policy.evaluate(snapshot({ atMs: 120_000, memoryMib: 4_100 }));
    policy.noteBrowserRestart();

    // During post-restart grace, large refill toward warning is ignored.
    now = 150_000;
    expect(
      policy.evaluate(snapshot({ atMs: 150_000, memoryMib: 5_200 })),
    ).toEqual({ action: 'none' });
    expect(policy.isRateGrowthSuppressed()).toBe(true);

    // After grace expires, growth above warning still restarts.
    now = 240_000;
    expect(policy.isRateGrowthSuppressed()).toBe(false);
    policy.evaluate(snapshot({ atMs: 240_000, memoryMib: 4_100 }));
    now = 270_000;
    expect(
      policy.evaluate(snapshot({ atMs: 270_000, memoryMib: 5_200 })),
    ).toEqual({
      action: 'restart_container',
      reason: 'fast_memory_growth',
    });
  });

  it('post-recycle observation 期間也不會因 refill 觸發 fast_memory_growth', () => {
    let now = 0;
    const policy = createPolicy(() => now);

    now = 120_000;
    policy.beginRecycleObservation(mibToBytes(5_000));
    expect(policy.isRateGrowthSuppressed()).toBe(true);

    now = 140_000;
    // Memory drops after recycle then climbs during session refill.
    expect(
      policy.evaluate(snapshot({ atMs: 140_000, memoryMib: 400 })),
    ).toEqual({ action: 'none' });
    now = 160_000;
    expect(
      policy.evaluate(snapshot({ atMs: 160_000, memoryMib: 1_700 })),
    ).toEqual({ action: 'none' });
  });

  it('post-recycle 成功後清除觀察；逾時則 container restart', () => {
    const policy = createPolicy();
    policy.beginRecycleObservation(mibToBytes(5_000));

    expect(
      policy.evaluate(snapshot({ atMs: 1_000, memoryMib: 3_500 })),
    ).toEqual({ action: 'none' });
    expect(policy.isRecycleObservationActive()).toBe(false);

    const policyTimeout = createPolicy();
    policyTimeout.beginRecycleObservation(mibToBytes(5_000));
    expect(
      policyTimeout.evaluate(snapshot({ atMs: 0, memoryMib: 4_800 })),
    ).toEqual({ action: 'none' });
    expect(
      policyTimeout.evaluate(snapshot({ atMs: 21_000, memoryMib: 4_800 })),
    ).toEqual({
      action: 'restart_container',
      reason: 'post_recycle_reclamation_failed',
    });
  });

  it('memory.events.high 上升可被 takeMemoryHighEvent 讀取且非 fatal', () => {
    const policy = createPolicy();
    policy.evaluate(snapshot({ atMs: 0, memoryMib: 1_000, high: 0n }));
    const decision = policy.evaluate(
      snapshot({ atMs: 2_000, memoryMib: 1_000, high: 1n }),
    );
    expect(decision).toEqual({ action: 'none' });
    expect(policy.takeMemoryHighEvent()).toBe(true);
    expect(policy.takeMemoryHighEvent()).toBe(false);
  });
});
