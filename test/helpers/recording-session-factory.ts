import type {
  ChannelHealthResult,
  ChannelSession,
  ChannelSessionFactory,
  ChannelSessionState,
} from '../../src/browser/ChannelSession.js';
import type { RewardClaimResult } from '../../src/browser/RewardClaimer.js';

const CHECKED_AT = '2026-06-14T12:00:00.000Z';

export type SessionLifecycleEvent =
  | {
      readonly type: 'created' | 'started';
      readonly channel: string;
      readonly generation: number;
    }
  | {
      readonly type: 'stopped';
      readonly channel: string;
      readonly generation: number;
      readonly reason: string;
    };

export interface RecordingSessionHooks {
  readonly onStart?: (session: RecordingChannelSession) => Promise<void>;
  readonly onStop?: (
    session: RecordingChannelSession,
    reason: string,
  ) => Promise<void>;
}

export class RecordingChannelSession implements ChannelSession {
  private currentState: ChannelSessionState = 'stopped';

  public constructor(
    public readonly channel: string,
    public readonly generation: number,
    private readonly events: SessionLifecycleEvent[],
    private readonly hooks: RecordingSessionHooks,
  ) {}

  public get state(): ChannelSessionState {
    return this.currentState;
  }

  public async start(): Promise<void> {
    this.currentState = 'starting';
    await this.hooks.onStart?.(this);
    this.currentState = 'watching';
    this.events.push({
      type: 'started',
      channel: this.channel,
      generation: this.generation,
    });
  }

  public async stop(reason: string): Promise<void> {
    this.currentState = 'stopping';
    await this.hooks.onStop?.(this, reason);
    this.currentState = 'stopped';
    this.events.push({
      type: 'stopped',
      channel: this.channel,
      generation: this.generation,
      reason,
    });
  }

  public async checkHealth(): Promise<ChannelHealthResult> {
    return { healthy: true, reason: 'live' };
  }

  public async tickRewardClaim(): Promise<RewardClaimResult> {
    return {
      status: 'not_found',
      channel: this.channel,
      checkedAt: CHECKED_AT,
    };
  }
}

export class RecordingChannelSessionFactory
  implements ChannelSessionFactory
{
  public readonly events: SessionLifecycleEvent[] = [];
  public readonly sessions: RecordingChannelSession[] = [];

  public constructor(private readonly hooks: RecordingSessionHooks = {}) {}

  public create(channel: string): ChannelSession {
    const generation =
      this.sessions.filter((session) => session.channel === channel).length + 1;
    const session = new RecordingChannelSession(
      channel,
      generation,
      this.events,
      this.hooks,
    );
    this.sessions.push(session);
    this.events.push({ type: 'created', channel, generation });
    return session;
  }

  public sessionsFor(channel: string): readonly RecordingChannelSession[] {
    return this.sessions.filter((session) => session.channel === channel);
  }
}
