import { describe, expect, it } from 'vitest';

import {
  clampEffectiveThresholdsToMemoryMax,
  computeEffectiveResourceGuardThresholds,
  mibToBytes,
  serializableByteCount,
} from '../../src/config/resourceGuardThresholds.js';

const anchors = {
  scaleWithStreams: true,
  baselineStreams: 3,
  baseMemoryMib: 512,
  warningMemoryMib: 4_096,
  warningResetMemoryMib: 3_840,
  browserRecycleMemoryMib: 4_608,
  emergencyMemoryMib: 5_376,
  postRecycleTargetMemoryMib: 4_096,
} as const;

describe('computeEffectiveResourceGuardThresholds', () => {
  it('N=3 時維持錨點', () => {
    expect(computeEffectiveResourceGuardThresholds(anchors, 3)).toEqual({
      maxConcurrentStreams: 3,
      warningMemoryMib: 4_096,
      warningResetMemoryMib: 3_840,
      browserRecycleMemoryMib: 4_608,
      emergencyMemoryMib: 5_376,
      postRecycleTargetMemoryMib: 4_096,
    });
  });

  it('N=5 時依公式放大', () => {
    expect(computeEffectiveResourceGuardThresholds(anchors, 5)).toEqual({
      maxConcurrentStreams: 5,
      warningMemoryMib: 6_485,
      warningResetMemoryMib: 6_059,
      browserRecycleMemoryMib: 7_339,
      emergencyMemoryMib: 8_619,
      postRecycleTargetMemoryMib: 6_485,
    });
  });

  it('scale_with_streams 關閉時使用絕對值', () => {
    expect(
      computeEffectiveResourceGuardThresholds(
        { ...anchors, scaleWithStreams: false },
        5,
      ).warningMemoryMib,
    ).toBe(4_096);
  });
});

describe('clampEffectiveThresholdsToMemoryMax', () => {
  it('memory.max 低於 emergency 時往下壓並維持順序', () => {
    const effective = computeEffectiveResourceGuardThresholds(anchors, 5);
    const { clamped, effective: clampedEffective } =
      clampEffectiveThresholdsToMemoryMax(
        effective,
        mibToBytes(6_144),
      );

    expect(clamped).toBe(true);
    expect(clampedEffective.emergencyMemoryMib).toBe(6_144 - 512);
    expect(clampedEffective.warningMemoryMib).toBeLessThan(
      clampedEffective.browserRecycleMemoryMib,
    );
    expect(clampedEffective.browserRecycleMemoryMib).toBeLessThan(
      clampedEffective.emergencyMemoryMib,
    );
  });
});

describe('serializableByteCount', () => {
  it('安全整數以 number 輸出，過大值以字串輸出', () => {
    expect(serializableByteCount(10n)).toBe(10);
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    expect(serializableByteCount(huge)).toBe(huge.toString());
  });
});
