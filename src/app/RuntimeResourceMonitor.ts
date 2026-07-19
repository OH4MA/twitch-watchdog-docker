import type { BrowserManager } from '../browser/index.js';
import type { ResourceGuardConfig } from '../config/AppConfig.js';
import type { Logger } from '../logging/index.js';
import type { SessionManager } from '../sessions/index.js';
import type { ApplicationIntegration } from './AppRunner.js';
import {
  CgroupV2Reader,
  type CgroupSnapshot,
} from './CgroupV2Reader.js';
import type { ContainerRestartRequest } from './ContainerRestartController.js';
import {
  ResourceGuardPolicy,
  type ResourceGuardDecision,
} from './ResourceGuardPolicy.js';
import {
  clampEffectiveThresholdsToMemoryMax,
  serializableByteCount,
  type ResourceGuardPolicyConfig,
} from '../config/resourceGuardThresholds.js';

export type { ContainerRestartRequest } from './ContainerRestartController.js';

export interface RuntimeResourceMonitorOptions {
  readonly browserManager: Pick<BrowserManager, 'getPageCount' | 'restart'>;
  readonly sessionManager: Pick<SessionManager, 'getActiveChannels'>;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
  /** Normal telemetry cadence for runtime_resource_snapshot. */
  readonly intervalSeconds: number;
  readonly resourceGuard?: ResourceGuardConfig;
  readonly cgroupReader?: CgroupV2Reader;
  readonly now?: () => number;
  readonly onContainerRestartRequested?: (
    request: ContainerRestartRequest,
  ) => void | Promise<void>;
}

/**
 * Emits process + cgroup resource telemetry and executes ResourceGuardPolicy.
 */
export class RuntimeResourceMonitor implements ApplicationIntegration {
  private readonly now: () => number;
  private readonly cgroupReader: CgroupV2Reader;
  private readonly resourceGuard: ResourceGuardConfig | undefined;
  private policy: ResourceGuardPolicy | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sampleFlight: Promise<void> | undefined;
  private stopped = true;
  private cgroupAvailable: boolean | undefined;
  private cgroupUnavailableLogged = false;
  private thresholdsClampedLogged = false;
  private recycleInFlight = false;
  private lastTelemetryAtMs = 0;
  private resourceGuardState:
    | 'disabled'
    | 'unavailable'
    | 'idle'
    | 'warning'
    | 'recycling'
    | 'observing'
    | 'restarting' = 'disabled';

  public constructor(private readonly options: RuntimeResourceMonitorOptions) {
    if (
      !Number.isSafeInteger(options.intervalSeconds) ||
      options.intervalSeconds <= 0
    ) {
      throw new TypeError('intervalSeconds must be a positive integer');
    }
    this.now = options.now ?? (() => performance.now());
    this.cgroupReader = options.cgroupReader ?? new CgroupV2Reader({ now: this.now });
    this.resourceGuard = options.resourceGuard;
  }

  public async start(): Promise<void> {
    if (!this.stopped && this.timer !== undefined) {
      return;
    }
    this.stopped = false;

    if (this.resourceGuard?.enabled === true) {
      this.policy = new ResourceGuardPolicy({
        config: toPolicyConfig(this.resourceGuard),
        now: this.now,
      });
      this.resourceGuardState = 'idle';
      this.options.logger.info('resource_guard_enabled', {
        ...serializeEffective(this.resourceGuard.effective),
        sampleIntervalSeconds: this.resourceGuard.sampleIntervalSeconds,
        scaleWithStreams: this.resourceGuard.scaleWithStreams,
      });
    } else {
      this.policy = undefined;
      this.resourceGuardState = 'disabled';
    }

    await this.runSample({ forceTelemetry: true });
    this.scheduleNextSample();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.sampleFlight !== undefined) {
      try {
        await this.sampleFlight;
      } catch {
        // Ignore in-flight sample errors during shutdown.
      }
    }
  }

  /**
   * Notify the guard that the browser was restarted outside the guard's own
   * recycle path (crash-loop recycle, disconnect recovery, etc.).
   */
  public notifyBrowserRestarted(): void {
    this.policy?.noteBrowserRestart();
  }

  private scheduleNextSample(): void {
    if (this.stopped) {
      return;
    }
    const intervalSeconds =
      this.resourceGuard?.enabled === true
        ? this.resourceGuard.sampleIntervalSeconds
        : this.options.intervalSeconds;
    const delayMs = Math.min(
      2_147_483_647,
      Math.max(1, intervalSeconds) * 1_000,
    );
    this.timer = setTimeout(() => {
      void this.runSample({ forceTelemetry: false }).finally(() => {
        this.scheduleNextSample();
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private runSample(options: { forceTelemetry: boolean }): Promise<void> {
    if (this.sampleFlight !== undefined) {
      return this.sampleFlight;
    }

    const flight = this.sampleOnce(options).finally(() => {
      if (this.sampleFlight === flight) {
        this.sampleFlight = undefined;
      }
    });
    this.sampleFlight = flight;
    return flight;
  }

  private async sampleOnce(options: {
    forceTelemetry: boolean;
  }): Promise<void> {
    if (this.stopped) {
      return;
    }

    const shouldLogTelemetry =
      options.forceTelemetry ||
      this.now() - this.lastTelemetryAtMs >=
        this.options.intervalSeconds * 1_000;

    let cgroup: CgroupSnapshot | undefined;
    if (this.resourceGuard?.enabled === true || this.cgroupAvailable !== false) {
      cgroup = await this.readCgroupSafely(shouldLogTelemetry);
    }

    if (
      cgroup !== undefined &&
      this.policy !== undefined &&
      !this.thresholdsClampedLogged
    ) {
      this.maybeClampThresholds(cgroup);
    }

    if (cgroup !== undefined && this.policy !== undefined && !this.recycleInFlight) {
      const decision = this.policy.evaluate(cgroup);
      await this.applyDecision(decision, cgroup);
    } else if (
      cgroup !== undefined &&
      this.policy !== undefined &&
      this.recycleInFlight &&
      this.policy.isRecycleObservationActive()
    ) {
      // Continue post-recycle observation while recycleInFlight is clearing.
      const decision = this.policy.evaluate(cgroup);
      await this.applyDecision(decision, cgroup);
    }

    if (cgroup !== undefined && this.policy?.takeMemoryHighEvent() === true) {
      this.options.logger.warn('resource_guard_memory_high_event', {
        memoryCurrentBytes: serializableByteCount(cgroup.memoryCurrentBytes),
        cgroupMemoryEventsHigh: serializableByteCount(cgroup.events.high),
      });
    }

    if (shouldLogTelemetry) {
      this.recordSnapshot(cgroup);
      this.lastTelemetryAtMs = this.now();
    }
  }

  private async readCgroupSafely(
    fullSnapshot: boolean,
  ): Promise<CgroupSnapshot | undefined> {
    try {
      if (this.cgroupAvailable === undefined) {
        const probe = await this.cgroupReader.probe();
        this.cgroupAvailable = probe.available;
        if (!probe.available) {
          this.logCgroupUnavailable(probe.reason);
          return undefined;
        }
      }
      if (this.cgroupAvailable === false) {
        return undefined;
      }
      return fullSnapshot
        ? await this.cgroupReader.readSnapshot()
        : await this.cgroupReader.readPolicySnapshot();
    } catch (error: unknown) {
      if (this.cgroupAvailable === true) {
        this.options.logger.debug('cgroup_sample_failed', {
          error: error instanceof Error ? error.message : 'unknown error',
        });
        return undefined;
      }
      this.cgroupAvailable = false;
      this.logCgroupUnavailable(
        error instanceof Error ? error.message : 'cgroup v2 is unavailable',
      );
      return undefined;
    }
  }

  private logCgroupUnavailable(reason: string): void {
    if (this.cgroupUnavailableLogged) {
      return;
    }
    this.cgroupUnavailableLogged = true;
    if (this.resourceGuard?.enabled === true) {
      this.resourceGuardState = 'unavailable';
    }
    this.options.logger.warn('cgroup_metrics_unavailable', { reason });
  }

  private maybeClampThresholds(snapshot: CgroupSnapshot): void {
    if (this.policy === undefined || this.resourceGuard === undefined) {
      return;
    }
    const { effective, clamped } = clampEffectiveThresholdsToMemoryMax(
      this.policy.getConfig().effective,
      snapshot.memoryMaxBytes,
    );
    this.thresholdsClampedLogged = true;
    if (!clamped) {
      return;
    }
    this.policy.updateConfig({
      ...this.policy.getConfig(),
      effective,
    });
    this.options.logger.warn('resource_guard_limit_clamped', {
      reason: 'memory_max_below_scaled_emergency',
      memoryMaxBytes: serializableByteCount(snapshot.memoryMaxBytes),
      ...serializeEffective(effective),
    });
  }

  private async applyDecision(
    decision: ResourceGuardDecision,
    snapshot: CgroupSnapshot,
  ): Promise<void> {
    switch (decision.action) {
      case 'none':
        if (
          this.resourceGuardState === 'warning' ||
          this.resourceGuardState === 'observing'
        ) {
          // Keep warning latch state in policy; monitor state returns to idle
          // when memory is healthy and not observing.
          if (!this.policy?.isRecycleObservationActive()) {
            this.resourceGuardState = 'idle';
          }
        }
        return;
      case 'warn': {
        this.resourceGuardState = 'warning';
        const effective =
          this.policy?.getConfig().effective ??
          this.resourceGuard?.effective;
        this.options.logger.warn('resource_guard_warning', {
          reason: decision.reason,
          memoryCurrentBytes: serializableByteCount(snapshot.memoryCurrentBytes),
          swapCurrentBytes: serializableByteCount(snapshot.swapCurrentBytes),
          ...(effective === undefined ? {} : serializeEffective(effective)),
        });
        return;
      }
      case 'recycle_browser':
        await this.recycleBrowser(decision.reason, snapshot);
        return;
      case 'restart_container':
        await this.requestContainerRestart(decision.reason, snapshot);
        return;
      default: {
        const _exhaustive: never = decision;
        return _exhaustive;
      }
    }
  }

  private async recycleBrowser(
    reason: string,
    snapshot: CgroupSnapshot,
  ): Promise<void> {
    if (this.recycleInFlight) {
      return;
    }
    this.recycleInFlight = true;
    this.resourceGuardState = 'recycling';
    const memoryBeforeBytes = snapshot.memoryCurrentBytes;
    this.options.logger.warn('resource_guard_browser_recycle_requested', {
      reason,
      memoryCurrentBytes: serializableByteCount(memoryBeforeBytes),
      swapCurrentBytes: serializableByteCount(snapshot.swapCurrentBytes),
    });

    try {
      await this.options.browserManager.restart();
      this.policy?.beginRecycleObservation(memoryBeforeBytes);
      this.resourceGuardState = 'observing';
      this.options.logger.info('resource_guard_browser_recycle_completed', {
        reason,
        memoryBeforeBytes: serializableByteCount(memoryBeforeBytes),
      });
    } catch (error: unknown) {
      this.options.logger.error('resource_guard_browser_recycle_failed', {
        reason,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      await this.requestContainerRestart('browser_recycle_failed', snapshot, {
        recycleReason: reason,
      });
    } finally {
      this.recycleInFlight = false;
    }
  }

  private async requestContainerRestart(
    reason: string,
    snapshot: CgroupSnapshot,
    extraFields: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    if (this.resourceGuardState === 'restarting') {
      return;
    }
    this.resourceGuardState = 'restarting';
    const fields = {
      reason,
      source: 'resource_guard',
      memoryCurrentBytes: serializableByteCount(snapshot.memoryCurrentBytes),
      swapCurrentBytes: serializableByteCount(snapshot.swapCurrentBytes),
      ...extraFields,
    };
    this.options.logger.error('resource_guard_container_restart_requested', fields);

    const handler = this.options.onContainerRestartRequested;
    if (handler === undefined) {
      return;
    }
    try {
      await handler({
        reason,
        source: 'resource_guard',
        fields,
      });
    } catch (error: unknown) {
      this.options.logger.error('resource_guard_container_restart_handler_failed', {
        reason,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  private recordSnapshot(cgroup: CgroupSnapshot | undefined): void {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const resources = process.resourceUsage();
    const events = cgroup?.events;
    const cgroupCpu = cgroup?.cpu;

    this.options.logger.info('runtime_resource_snapshot', {
      processCpuUserUs: cpu.user,
      processCpuSystemUs: cpu.system,
      processRssBytes: memory.rss,
      processHeapUsedBytes: memory.heapUsed,
      processExternalBytes: memory.external,
      processMaxRssKb: resources.maxRSS,
      activeChannelCount:
        this.options.sessionManager.getActiveChannels().length,
      browserPageCount: this.options.browserManager.getPageCount(),
      cgroupMemoryCurrentBytes: serializableByteCount(
        cgroup?.memoryCurrentBytes,
      ),
      cgroupMemoryPeakBytes: serializableByteCount(cgroup?.memoryPeakBytes),
      cgroupSwapCurrentBytes: serializableByteCount(cgroup?.swapCurrentBytes),
      cgroupPidsCurrent: serializableByteCount(cgroup?.pidsCurrent),
      cgroupCpuUsageUsec: serializableByteCount(cgroupCpu?.usageUsec),
      cgroupCpuUserUsec: serializableByteCount(cgroupCpu?.userUsec),
      cgroupCpuSystemUsec: serializableByteCount(cgroupCpu?.systemUsec),
      cgroupMemoryEventsHigh: serializableByteCount(events?.high),
      cgroupMemoryEventsMax: serializableByteCount(events?.max),
      cgroupMemoryEventsOom: serializableByteCount(events?.oom),
      cgroupMemoryEventsOomKill: serializableByteCount(events?.oomKill),
      resourceGuardState: this.resourceGuardState,
      browserRecycleInFlight: this.recycleInFlight,
    });
  }
}

function toPolicyConfig(guard: ResourceGuardConfig): ResourceGuardPolicyConfig {
  return {
    sampleIntervalSeconds: guard.sampleIntervalSeconds,
    startupRateGraceSeconds: guard.startupRateGraceSeconds,
    browserRecycleConsecutiveSamples: guard.browserRecycleConsecutiveSamples,
    emergencySwapMib: guard.emergencySwapMib,
    fastGrowthMib: guard.fastGrowthMib,
    fastGrowthWindowSeconds: guard.fastGrowthWindowSeconds,
    postBrowserRestartRateGraceSeconds:
      guard.postBrowserRestartRateGraceSeconds,
    postRecycleObservationSeconds: guard.postRecycleObservationSeconds,
    postRecycleMinimumDropMib: guard.postRecycleMinimumDropMib,
    effective: guard.effective,
  };
}

function serializeEffective(
  effective: ResourceGuardConfig['effective'],
): Record<string, number> {
  return {
    maxConcurrentStreams: effective.maxConcurrentStreams,
    warningMemoryMib: effective.warningMemoryMib,
    warningResetMemoryMib: effective.warningResetMemoryMib,
    browserRecycleMemoryMib: effective.browserRecycleMemoryMib,
    emergencyMemoryMib: effective.emergencyMemoryMib,
    postRecycleTargetMemoryMib: effective.postRecycleTargetMemoryMib,
  };
}
