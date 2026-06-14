import type { ChannelLiveStatus } from '../twitch/index.js';

export type { ChannelLiveStatus } from '../twitch/index.js';

export interface StreamSelectionInput {
  readonly configuredChannels: readonly string[];
  readonly liveStatuses: readonly ChannelLiveStatus[];
  readonly maxConcurrentStreams: number;
}

export interface StreamSelector {
  selectActiveChannels(input: StreamSelectionInput): string[];
}

export function selectActiveChannels(
  input: StreamSelectionInput,
): string[] {
  if (
    !Number.isSafeInteger(input.maxConcurrentStreams) ||
    input.maxConcurrentStreams <= 0
  ) {
    return [];
  }

  const liveByChannel = collectConservativeLiveStatuses(
    input.liveStatuses,
  );
  const selectedChannels: string[] = [];
  const configuredChannelsSeen = new Set<string>();

  for (const channel of input.configuredChannels) {
    const normalizedChannel = normalizeChannel(channel);

    if (configuredChannelsSeen.has(normalizedChannel)) {
      continue;
    }
    configuredChannelsSeen.add(normalizedChannel);

    if (liveByChannel.get(normalizedChannel) !== true) {
      continue;
    }

    selectedChannels.push(channel);
    if (selectedChannels.length === input.maxConcurrentStreams) {
      break;
    }
  }

  return selectedChannels;
}

function collectConservativeLiveStatuses(
  liveStatuses: readonly ChannelLiveStatus[],
): ReadonlyMap<string, boolean> {
  const liveByChannel = new Map<string, boolean>();

  for (const status of liveStatuses) {
    const normalizedChannel = normalizeChannel(status.channel);
    const previousStatus = liveByChannel.get(normalizedChannel);

    liveByChannel.set(
      normalizedChannel,
      previousStatus === undefined
        ? status.isLive
        : previousStatus && status.isLive,
    );
  }

  return liveByChannel;
}

function normalizeChannel(channel: string): string {
  return channel.toLowerCase();
}
