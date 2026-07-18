import type {
  ResourceGuardConfig,
  ResourceGuardEffectiveThresholds,
} from './AppConfig.js';

const MIB = 1_048_576;

export interface ResourceGuardAnchorThresholds {
  readonly scaleWithStreams: boolean;
  readonly baselineStreams: number;
  readonly baseMemoryMib: number;
  readonly warningMemoryMib: number;
  readonly warningResetMemoryMib: number;
  readonly browserRecycleMemoryMib: number;
  readonly emergencyMemoryMib: number;
  readonly postRecycleTargetMemoryMib: number;
}

/**
 * Scale N=baselineStreams anchors to the configured concurrent stream budget.
 * effective = base + (anchor - base) * (N / baseline) when scaleWithStreams is true.
 */
export function computeEffectiveResourceGuardThresholds(
  anchors: ResourceGuardAnchorThresholds,
  maxConcurrentStreams: number,
): ResourceGuardEffectiveThresholds {
  const streamCount = Math.max(1, maxConcurrentStreams);
  const scale = (anchorMib: number): number => {
    if (!anchors.scaleWithStreams) {
      return Math.round(anchorMib);
    }
    const baseline = Math.max(1, anchors.baselineStreams);
    const base = Math.max(0, anchors.baseMemoryMib);
    const scaled =
      base + (anchorMib - base) * (streamCount / baseline);
    return Math.max(1, Math.round(scaled));
  };

  const warningMemoryMib = scale(anchors.warningMemoryMib);
  const warningResetMemoryMib = Math.min(
    scale(anchors.warningResetMemoryMib),
    warningMemoryMib - 1,
  );
  const browserRecycleMemoryMib = scale(anchors.browserRecycleMemoryMib);
  const emergencyMemoryMib = scale(anchors.emergencyMemoryMib);
  const postRecycleTargetMemoryMib = scale(
    anchors.postRecycleTargetMemoryMib,
  );

  return {
    maxConcurrentStreams: streamCount,
    warningMemoryMib,
    warningResetMemoryMib: Math.max(1, warningResetMemoryMib),
    browserRecycleMemoryMib,
    emergencyMemoryMib,
    postRecycleTargetMemoryMib,
  };
}

/**
 * Keep policy thresholds under an optional cgroup memory.max hard limit.
 * Returns the same object when no clamp is needed or max is unavailable.
 */
export function clampEffectiveThresholdsToMemoryMax(
  effective: ResourceGuardEffectiveThresholds,
  memoryMaxBytes: bigint | undefined,
): {
  readonly effective: ResourceGuardEffectiveThresholds;
  readonly clamped: boolean;
} {
  if (memoryMaxBytes === undefined || memoryMaxBytes <= 0n) {
    return { effective, clamped: false };
  }
  if (memoryMaxBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { effective, clamped: false };
  }

  const memoryMaxMib = Number(memoryMaxBytes) / MIB;
  // Leave headroom so emergency can fire before the kernel OOM killer.
  const emergencyCap = Math.max(1, Math.floor(memoryMaxMib - 512));
  if (effective.emergencyMemoryMib <= emergencyCap) {
    return { effective, clamped: false };
  }

  const emergencyMemoryMib = emergencyCap;
  const browserRecycleMemoryMib = Math.min(
    effective.browserRecycleMemoryMib,
    Math.max(1, emergencyMemoryMib - 256),
  );
  const warningMemoryMib = Math.min(
    effective.warningMemoryMib,
    Math.max(1, browserRecycleMemoryMib - 256),
  );
  const warningResetMemoryMib = Math.min(
    effective.warningResetMemoryMib,
    Math.max(1, warningMemoryMib - 1),
  );
  const postRecycleTargetMemoryMib = Math.min(
    effective.postRecycleTargetMemoryMib,
    warningMemoryMib,
  );

  return {
    clamped: true,
    effective: {
      maxConcurrentStreams: effective.maxConcurrentStreams,
      warningMemoryMib,
      warningResetMemoryMib,
      browserRecycleMemoryMib,
      emergencyMemoryMib,
      postRecycleTargetMemoryMib,
    },
  };
}

export function mibToBytes(mib: number): bigint {
  return BigInt(mib) * BigInt(MIB);
}

export function bytesToMibNumber(bytes: bigint): number {
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(bytes / BigInt(MIB));
  }
  return Number(bytes) / MIB;
}

/** Serialize cgroup byte counters for JSON logs without throwing on bigint. */
export function serializableByteCount(
  value: bigint | undefined,
): number | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return value.toString();
}

export type ResourceGuardPolicyConfig = Pick<
  ResourceGuardConfig,
  | 'startupRateGraceSeconds'
  | 'browserRecycleConsecutiveSamples'
  | 'emergencySwapMib'
  | 'fastGrowthMib'
  | 'fastGrowthWindowSeconds'
  | 'postBrowserRestartRateGraceSeconds'
  | 'postRecycleObservationSeconds'
  | 'postRecycleMinimumDropMib'
  | 'sampleIntervalSeconds'
> & {
  readonly effective: ResourceGuardEffectiveThresholds;
};
