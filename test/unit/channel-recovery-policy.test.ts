import { describe, expect, it } from 'vitest';

import { ChannelRecoveryPolicy } from '../../src/sessions/ChannelRecoveryPolicy.js';
import {
  createDefaultBrowserRecovery,
  createDefaultBrowserSessionStart,
} from '../helpers/test-config.js';

function createHarness() {
  let nowMs = 0;
  const policy = new ChannelRecoveryPolicy({
    recovery: createDefaultBrowserRecovery(),
    sessionStart: createDefaultBrowserSessionStart(),
    now: () => nowMs,
  });
  return {
    policy,
    setNow(nextNowMs: number): void {
      nowMs = nextNowMs;
    },
  };
}

describe('ChannelRecoveryPolicy', () => {
  it('前三次單頻道 crash 依序產生 30、60、120 秒 backoff', () => {
    const { policy, setNow } = createHarness();

    expect(policy.recordPageCrash('Channel')).toEqual({
      status: 'backoff',
      retryAtMs: 30_000,
      consecutivePageCrashes: 1,
    });
    setNow(30_000);
    expect(policy.recordPageCrash('channel')).toEqual({
      status: 'backoff',
      retryAtMs: 90_000,
      consecutivePageCrashes: 2,
    });
    setNow(90_000);
    expect(policy.recordPageCrash('CHANNEL')).toEqual({
      status: 'backoff',
      retryAtMs: 210_000,
      consecutivePageCrashes: 3,
    });
    expect(policy.getState('channel').pageCrashTimestampsMs).toEqual([
      0,
      30_000,
      90_000,
    ]);
  });

  it('十分鐘視窗內第四次 crash 進入十五分鐘 quarantine', () => {
    const { policy, setNow } = createHarness();

    for (const crashAtMs of [0, 30_000, 90_000]) {
      setNow(crashAtMs);
      policy.recordPageCrash('channel');
    }
    setNow(210_000);

    expect(policy.recordPageCrash('channel')).toEqual({
      status: 'quarantined',
      retryAtMs: 1_110_000,
      consecutivePageCrashes: 4,
    });
    expect(policy.getAvailability('channel')).toEqual({
      status: 'quarantined',
      retryAtMs: 1_110_000,
      recoveryGeneration: 0,
    });
  });

  it('quarantine 到期後只允許一個 probe 並以 generation 排除過期結果', () => {
    const { policy, setNow } = createHarness();
    for (const crashAtMs of [0, 30_000, 90_000, 210_000]) {
      setNow(crashAtMs);
      policy.recordPageCrash('channel');
    }

    setNow(1_110_000);
    expect(policy.beginProbe('channel')).toEqual({
      status: 'started',
      recoveryGeneration: 1,
    });
    expect(policy.beginProbe('CHANNEL')).toEqual({
      status: 'probe_in_flight',
      recoveryGeneration: 1,
    });
    expect(policy.markStable('channel', 0)).toBe(false);
    expect(policy.markStable('channel', 1)).toBe(true);
    expect(policy.isCurrentGeneration('channel', 1)).toBe(true);
  });

  it('持續穩定三十分鐘後才重設 failure state', () => {
    const { policy, setNow } = createHarness();
    policy.recordPageCrash('channel');
    setNow(30_000);
    policy.recordStartFailure('channel');
    setNow(900_000);
    const probe = policy.beginProbe('channel');
    expect(probe.status).toBe('started');
    if (probe.status !== 'started') {
      throw new Error('Expected recovery probe to start');
    }
    expect(policy.markStable('channel', probe.recoveryGeneration)).toBe(true);

    setNow(900_000 + 1_800_000 - 1);
    expect(policy.getState('channel')).toMatchObject({
      consecutivePageCrashes: 1,
      consecutiveStartFailures: 1,
      stableSinceMs: 900_000,
    });

    setNow(900_000 + 1_800_000);
    expect(policy.getState('channel')).toEqual({
      consecutivePageCrashes: 0,
      consecutiveStartFailures: 0,
      pageCrashTimestampsMs: [],
      recoveryGeneration: 1,
    });
  });

  it('穩定期屆滿後的下一次 crash 會視為第一次', () => {
    const { policy, setNow } = createHarness();
    policy.recordPageCrash('channel');
    setNow(30_000);
    const probe = policy.beginProbe('channel');
    expect(probe.status).toBe('started');
    if (probe.status !== 'started') {
      throw new Error('Expected recovery probe to start');
    }
    policy.markStable('channel', probe.recoveryGeneration);

    setNow(1_830_000);
    expect(policy.recordPageCrash('channel')).toEqual({
      status: 'backoff',
      retryAtMs: 1_860_000,
      consecutivePageCrashes: 1,
    });
  });

  it('start failure 依序使用 30、60、120 秒後以十五分鐘為上限', () => {
    const { policy } = createHarness();

    expect(
      [1, 2, 3, 4, 5].map(() =>
        policy.recordStartFailure('channel').retryAtMs,
      ),
    ).toEqual([30_000, 60_000, 120_000, 900_000, 900_000]);
  });

  it('狀態 key 不區分大小寫，只有移除設定頻道時完全清除', () => {
    const { policy } = createHarness();
    policy.recordPageCrash('MixedCase');

    expect(policy.getState('mixedcase').consecutivePageCrashes).toBe(1);
    policy.removeChannel('MIXEDCASE');
    expect(policy.getState('mixedcase')).toEqual({
      consecutivePageCrashes: 0,
      consecutiveStartFailures: 0,
      pageCrashTimestampsMs: [],
      recoveryGeneration: 0,
    });
  });
});
