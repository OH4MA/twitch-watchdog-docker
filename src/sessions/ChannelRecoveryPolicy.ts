import type {
  BrowserRecoveryConfig,
  BrowserSessionStartConfig,
} from '../config/AppConfig.js';

export interface ChannelRecoveryState {
  consecutivePageCrashes: number;
  consecutiveStartFailures: number;
  pageCrashTimestampsMs: number[];
  nextRetryAtMs?: number;
  quarantinedUntilMs?: number;
  stableSinceMs?: number;
  recoveryGeneration: number;
}

export type ChannelRecoveryAvailability =
  | {
      readonly status: 'eligible';
      readonly recoveryGeneration: number;
    }
  | {
      readonly status: 'deferred';
      readonly retryAtMs: number;
      readonly recoveryGeneration: number;
    }
  | {
      readonly status: 'quarantined';
      readonly retryAtMs: number;
      readonly recoveryGeneration: number;
    }
  | {
      readonly status: 'probe_in_flight';
      readonly recoveryGeneration: number;
    };

export type PageCrashRecoveryDecision =
  | {
      readonly status: 'backoff';
      readonly retryAtMs: number;
      readonly consecutivePageCrashes: number;
    }
  | {
      readonly status: 'quarantined';
      readonly retryAtMs: number;
      readonly consecutivePageCrashes: number;
    };

export interface StartFailureRecoveryDecision {
  readonly status: 'backoff';
  readonly retryAtMs: number;
  readonly consecutiveStartFailures: number;
}

export type BeginRecoveryProbeResult =
  | {
      readonly status: 'started';
      readonly recoveryGeneration: number;
    }
  | Exclude<ChannelRecoveryAvailability, { readonly status: 'eligible' }>;

export interface ChannelRecoveryPolicyOptions {
  readonly recovery: BrowserRecoveryConfig;
  readonly sessionStart: BrowserSessionStartConfig;
  readonly now?: () => number;
}

/**
 * 保存獨立於 active session registry 的頻道復原狀態。
 */
export class ChannelRecoveryPolicy {
  private readonly states = new Map<string, ChannelRecoveryState>();
  private readonly probesInFlight = new Set<string>();
  private readonly now: () => number;

  public constructor(private readonly options: ChannelRecoveryPolicyOptions) {
    this.now = options.now ?? Date.now;
  }

  public getState(channel: string): Readonly<ChannelRecoveryState> {
    const key = normalizeRecoveryChannel(channel);
    const state = this.getOrCreateState(key);
    this.resetAfterStablePeriodIfNeeded(key, state);
    return cloneState(state);
  }

  public getAvailability(channel: string): ChannelRecoveryAvailability {
    const key = normalizeRecoveryChannel(channel);
    const state = this.getOrCreateState(key);
    this.resetAfterStablePeriodIfNeeded(key, state);
    const nowMs = this.now();

    if (
      state.quarantinedUntilMs !== undefined &&
      nowMs < state.quarantinedUntilMs
    ) {
      return {
        status: 'quarantined',
        retryAtMs: state.quarantinedUntilMs,
        recoveryGeneration: state.recoveryGeneration,
      };
    }
    if (this.probesInFlight.has(key)) {
      return {
        status: 'probe_in_flight',
        recoveryGeneration: state.recoveryGeneration,
      };
    }
    if (state.nextRetryAtMs !== undefined && nowMs < state.nextRetryAtMs) {
      return {
        status: 'deferred',
        retryAtMs: state.nextRetryAtMs,
        recoveryGeneration: state.recoveryGeneration,
      };
    }
    return {
      status: 'eligible',
      recoveryGeneration: state.recoveryGeneration,
    };
  }

  public recordPageCrash(channel: string): PageCrashRecoveryDecision {
    const key = normalizeRecoveryChannel(channel);
    const state = this.getOrCreateState(key);
    this.resetAfterStablePeriodIfNeeded(key, state);
    const nowMs = this.now();
    this.probesInFlight.delete(key);
    delete state.stableSinceMs;
    state.consecutivePageCrashes += 1;
    state.pageCrashTimestampsMs = state.pageCrashTimestampsMs.filter(
      (timestampMs) =>
        nowMs - timestampMs <=
        this.options.recovery.channelCrashWindowSeconds * 1_000,
    );
    state.pageCrashTimestampsMs.push(nowMs);

    if (
      state.pageCrashTimestampsMs.length >=
      this.options.recovery.channelQuarantineThreshold
    ) {
      const retryAtMs =
        nowMs + this.options.recovery.channelQuarantineSeconds * 1_000;
      state.quarantinedUntilMs = retryAtMs;
      delete state.nextRetryAtMs;
      return {
        status: 'quarantined',
        retryAtMs,
        consecutivePageCrashes: state.consecutivePageCrashes,
      };
    }

    const retryAtMs = nowMs + this.pageCrashBackoffMs(state);
    state.nextRetryAtMs = retryAtMs;
    return {
      status: 'backoff',
      retryAtMs,
      consecutivePageCrashes: state.consecutivePageCrashes,
    };
  }

  public recordStartFailure(channel: string): StartFailureRecoveryDecision {
    const key = normalizeRecoveryChannel(channel);
    const state = this.getOrCreateState(key);
    this.resetAfterStablePeriodIfNeeded(key, state);
    const nowMs = this.now();
    this.probesInFlight.delete(key);
    delete state.stableSinceMs;
    state.consecutiveStartFailures += 1;
    const configuredBackoffs = this.options.sessionStart.failureBackoffSeconds;
    const backoffSeconds =
      configuredBackoffs[state.consecutiveStartFailures - 1] ??
      this.options.sessionStart.maximumCooldownSeconds;
    const retryAtMs =
      nowMs +
      Math.min(
        backoffSeconds,
        this.options.sessionStart.maximumCooldownSeconds,
      ) * 1_000;
    state.nextRetryAtMs = retryAtMs;
    return {
      status: 'backoff',
      retryAtMs,
      consecutiveStartFailures: state.consecutiveStartFailures,
    };
  }

  public beginProbe(channel: string): BeginRecoveryProbeResult {
    const availability = this.getAvailability(channel);
    if (availability.status !== 'eligible') {
      return availability;
    }

    const key = normalizeRecoveryChannel(channel);
    const state = this.getOrCreateState(key);
    state.recoveryGeneration += 1;
    delete state.nextRetryAtMs;
    delete state.quarantinedUntilMs;
    this.probesInFlight.add(key);
    return {
      status: 'started',
      recoveryGeneration: state.recoveryGeneration,
    };
  }

  public markStable(channel: string, recoveryGeneration: number): boolean {
    const key = normalizeRecoveryChannel(channel);
    const state = this.states.get(key);
    if (
      state === undefined ||
      state.recoveryGeneration !== recoveryGeneration
    ) {
      return false;
    }

    this.probesInFlight.delete(key);
    state.stableSinceMs = this.now();
    return true;
  }

  public cancelProbe(channel: string, recoveryGeneration: number): boolean {
    const key = normalizeRecoveryChannel(channel);
    const state = this.states.get(key);
    if (
      state === undefined ||
      state.recoveryGeneration !== recoveryGeneration ||
      !this.probesInFlight.has(key)
    ) {
      return false;
    }
    this.probesInFlight.delete(key);
    return true;
  }

  public isCurrentGeneration(
    channel: string,
    recoveryGeneration: number,
  ): boolean {
    return (
      this.states.get(normalizeRecoveryChannel(channel))
        ?.recoveryGeneration === recoveryGeneration
    );
  }

  public removeChannel(channel: string): void {
    const key = normalizeRecoveryChannel(channel);
    this.probesInFlight.delete(key);
    this.states.delete(key);
  }

  private pageCrashBackoffMs(state: ChannelRecoveryState): number {
    const backoffs = this.options.recovery.pageCrashBackoffSeconds;
    const index = Math.min(
      state.consecutivePageCrashes - 1,
      backoffs.length - 1,
    );
    return backoffs[index]! * 1_000;
  }

  private getOrCreateState(key: string): ChannelRecoveryState {
    const existing = this.states.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const state: ChannelRecoveryState = {
      consecutivePageCrashes: 0,
      consecutiveStartFailures: 0,
      pageCrashTimestampsMs: [],
      recoveryGeneration: 0,
    };
    this.states.set(key, state);
    return state;
  }

  private resetAfterStablePeriodIfNeeded(
    key: string,
    state: ChannelRecoveryState,
  ): void {
    if (
      state.stableSinceMs === undefined ||
      this.now() - state.stableSinceMs <
        this.options.recovery.stableResetSeconds * 1_000
    ) {
      return;
    }

    state.consecutivePageCrashes = 0;
    state.consecutiveStartFailures = 0;
    state.pageCrashTimestampsMs = [];
    delete state.nextRetryAtMs;
    delete state.quarantinedUntilMs;
    delete state.stableSinceMs;
    this.probesInFlight.delete(key);
  }
}

export function normalizeRecoveryChannel(channel: string): string {
  return channel.toLowerCase();
}

function cloneState(
  state: ChannelRecoveryState,
): Readonly<ChannelRecoveryState> {
  return {
    ...state,
    pageCrashTimestampsMs: [...state.pageCrashTimestampsMs],
  };
}
