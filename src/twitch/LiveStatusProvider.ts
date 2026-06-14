export interface ChannelLiveStatus {
  readonly channel: string;
  readonly isLive: boolean;
  readonly streamId?: string;
  readonly title?: string;
  readonly startedAt?: string;
  readonly viewerCount?: number;
  readonly checkedAt: string;
}

export interface LiveStatusProvider {
  getLiveStatuses(
    channels: readonly string[],
  ): Promise<ChannelLiveStatus[]>;
}
