import type { CgroupSnapshot } from './CgroupV2Reader.js';
import {
  bytesToMibNumber,
  mibToBytes,
  type ResourceGuardPolicyConfig,
} from '../config/resourceGuardThresholds.js';

export type ResourceGuardDecision =
  | { readonly action: 'none' }
  | { readonly action: 'warn'; readonly reason: string }
  | {
      readonly action: 'recycle_browser';
      readonly reason: string;
    }
  | {
      readonly action: 'restart_container';
      readonly reason: string;
    };

export interface ResourceGuardPolicyOptions {
  readonly config: ResourceGuardPolicyConfig;
  readonly now?: () => number;
}

interface SamplePoint {
  readonly atMs: number;
  readonly memoryCurrentBytes: bigint;
}

/**
 * Pure decision state machine over cgroup snapshots.
 * Measurement and side effects live in RuntimeResourceMonitor.
 */
export class ResourceGuardPolicy {
  private readonly now: () => number;
  private config: ResourceGuardPolicyConfig;
  private startedAtMs: number | undefined;
  private warningLatched = false;
  private consecutiveHighSamples = 0;
  private sampleHistory: SamplePoint[] = [];
  private lastEvents:
    | {
        high: bigint;
        max: bigint;
        oom: bigint;
        oomKill: bigint;
      }
    | undefined;
  private pendingMemoryHighEvent = false;
  private recycleObservation:
    | {
        deadlineMs: number;
        memoryBeforeBytes: bigint;
      }
    | undefined;

  public constructor(options: ResourceGuardPolicyOptions) {
    this.config = options.config;
    this.now = options.now ?? (() => performance.now());
  }

  public updateConfig(config: ResourceGuardPolicyConfig): void {
    this.config = config;
  }

  public getConfig(): ResourceGuardPolicyConfig {
    return this.config;
  }

  public isRecycleObservationActive(): boolean {
    return this.recycleObservation !== undefined;
  }

  public beginRecycleObservation(memoryBeforeBytes: bigint): void {
    this.recycleObservation = {
      memoryBeforeBytes,
      deadlineMs:
        this.now() + this.config.postRecycleObservationSeconds * 1_000,
    };
    this.consecutiveHighSamples = 0;
  }

  public clearRecycleObservation(): void {
    this.recycleObservation = undefined;
  }

  public evaluate(snapshot: CgroupSnapshot): ResourceGuardDecision {
    const nowMs = snapshot.sampledAtMonotonicMs;
    this.startedAtMs ??= nowMs;
    this.pushSample(snapshot);

    const emergency = this.evaluateEmergency(snapshot);
    if (emergency !== undefined) {
      return emergency;
    }

    if (this.recycleObservation !== undefined) {
      const post = this.evaluatePostRecycle(snapshot);
      if (post !== undefined) {
        return post;
      }
      // Suppress further recycle while observing; emergencies already returned.
      return { action: 'none' };
    }

    const recycle = this.evaluateRecycle(snapshot);
    if (recycle !== undefined) {
      return recycle;
    }

    const warn = this.evaluateWarning(snapshot);
    if (warn !== undefined) {
      return warn;
    }

    return { action: 'none' };
  }

  private evaluateEmergency(
    snapshot: CgroupSnapshot,
  ): ResourceGuardDecision | undefined {
    // Always advance event counters first so deltas stay accurate.
    const eventEmergency = this.evaluateEventDeltas(snapshot);
    const effective = this.config.effective;
    const memoryMib = bytesToMibNumber(snapshot.memoryCurrentBytes);

    if (memoryMib >= effective.emergencyMemoryMib) {
      return {
        action: 'restart_container',
        reason: 'emergency_memory',
      };
    }

    if (
      snapshot.swapCurrentBytes !== undefined &&
      bytesToMibNumber(snapshot.swapCurrentBytes) >=
        this.config.emergencySwapMib
    ) {
      return {
        action: 'restart_container',
        reason: 'emergency_swap',
      };
    }

    if (eventEmergency !== undefined) {
      return eventEmergency;
    }

    const graceMs = this.config.startupRateGraceSeconds * 1_000;
    const pastGrace =
      this.startedAtMs !== undefined &&
      snapshot.sampledAtMonotonicMs - this.startedAtMs >= graceMs;
    if (pastGrace && this.hasFastGrowth(snapshot)) {
      return {
        action: 'restart_container',
        reason: 'fast_memory_growth',
      };
    }

    return undefined;
  }

  private evaluateEventDeltas(
    snapshot: CgroupSnapshot,
  ): ResourceGuardDecision | undefined {
    const current = snapshot.events;
    const previous = this.lastEvents;
    this.lastEvents = {
      high: current.high,
      max: current.max,
      oom: current.oom,
      oomKill: current.oomKill,
    };

    if (previous === undefined) {
      return undefined;
    }

    if (current.oom > previous.oom) {
      return { action: 'restart_container', reason: 'cgroup_oom' };
    }
    if (current.oomKill > previous.oomKill) {
      return { action: 'restart_container', reason: 'cgroup_oom_kill' };
    }
    if (current.max > previous.max) {
      return { action: 'restart_container', reason: 'cgroup_memory_max' };
    }
    if (current.high > previous.high) {
      // Logged by the monitor; not a fatal signal unless memory.high is configured.
      this.pendingMemoryHighEvent = true;
    }
    return undefined;
  }

  /** Consume one-shot high-event flag set during the latest evaluate() call. */
  public takeMemoryHighEvent(): boolean {
    const value = this.pendingMemoryHighEvent;
    this.pendingMemoryHighEvent = false;
    return value;
  }

  private evaluatePostRecycle(
    snapshot: CgroupSnapshot,
  ): ResourceGuardDecision | undefined {
    const observation = this.recycleObservation;
    if (observation === undefined) {
      return undefined;
    }

    const effective = this.config.effective;
    const memory = snapshot.memoryCurrentBytes;
    const targetBytes = mibToBytes(effective.postRecycleTargetMemoryMib);
    const recycleBytes = mibToBytes(effective.browserRecycleMemoryMib);
    const drop = observation.memoryBeforeBytes - memory;
    const minDrop = mibToBytes(this.config.postRecycleMinimumDropMib);

    const reachedTarget = memory < targetBytes;
    const sufficientDrop =
      drop >= minDrop && memory < recycleBytes;

    if (reachedTarget || sufficientDrop) {
      this.recycleObservation = undefined;
      this.consecutiveHighSamples = 0;
      return { action: 'none' };
    }

    if (snapshot.sampledAtMonotonicMs >= observation.deadlineMs) {
      this.recycleObservation = undefined;
      return {
        action: 'restart_container',
        reason: 'post_recycle_reclamation_failed',
      };
    }

    return undefined;
  }

  private evaluateRecycle(
    snapshot: CgroupSnapshot,
  ): ResourceGuardDecision | undefined {
    const recycleBytes = mibToBytes(
      this.config.effective.browserRecycleMemoryMib,
    );
    if (snapshot.memoryCurrentBytes >= recycleBytes) {
      this.consecutiveHighSamples += 1;
    } else {
      this.consecutiveHighSamples = 0;
      return undefined;
    }

    if (
      this.consecutiveHighSamples >=
      this.config.browserRecycleConsecutiveSamples
    ) {
      this.consecutiveHighSamples = 0;
      return {
        action: 'recycle_browser',
        reason: 'sustained_high_memory',
      };
    }

    return undefined;
  }

  private evaluateWarning(
    snapshot: CgroupSnapshot,
  ): ResourceGuardDecision | undefined {
    const warningBytes = mibToBytes(this.config.effective.warningMemoryMib);
    const resetBytes = mibToBytes(
      this.config.effective.warningResetMemoryMib,
    );

    if (snapshot.memoryCurrentBytes >= warningBytes) {
      if (!this.warningLatched) {
        this.warningLatched = true;
        return { action: 'warn', reason: 'memory_warning' };
      }
      return undefined;
    }

    if (snapshot.memoryCurrentBytes < resetBytes) {
      this.warningLatched = false;
    }
    return undefined;
  }

  private hasFastGrowth(snapshot: CgroupSnapshot): boolean {
    const windowMs = this.config.fastGrowthWindowSeconds * 1_000;
    const growthBytes = mibToBytes(this.config.fastGrowthMib);
    const nowMs = snapshot.sampledAtMonotonicMs;
    const oldestAllowed = nowMs - windowMs;

    let baseline: SamplePoint | undefined;
    for (const sample of this.sampleHistory) {
      if (sample.atMs >= oldestAllowed) {
        baseline = sample;
        break;
      }
    }
    if (baseline === undefined) {
      return false;
    }

    return (
      snapshot.memoryCurrentBytes >= baseline.memoryCurrentBytes + growthBytes
    );
  }

  private pushSample(snapshot: CgroupSnapshot): void {
    this.sampleHistory.push({
      atMs: snapshot.sampledAtMonotonicMs,
      memoryCurrentBytes: snapshot.memoryCurrentBytes,
    });

    // Keep a bounded window slightly larger than the growth window.
    const retainMs =
      Math.max(
        this.config.fastGrowthWindowSeconds,
        this.config.sampleIntervalSeconds,
      ) *
        1_000 +
      this.config.sampleIntervalSeconds * 1_000 * 2;
    const cutoff = snapshot.sampledAtMonotonicMs - retainMs;
    this.sampleHistory = this.sampleHistory.filter(
      (sample) => sample.atMs >= cutoff,
    );
  }

}
