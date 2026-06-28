import type { RuntimeWatchConfig } from '../config/index.js';
import type { WatchdogSchedulerSnapshot } from '../scheduler/index.js';
import type {
  ChannelSessionRefreshStatus,
  SessionRefreshResult,
  SessionScreenshot,
} from '../sessions/index.js';

export interface BotCommandContext {
  runCheck(): Promise<void>;
  pauseChecks(): Promise<void>;
  resumeChecks(): void;
  getSchedulerSnapshot(): WatchdogSchedulerSnapshot;
  getActiveChannels(): string[];
  getRefreshStatuses(): readonly ChannelSessionRefreshStatus[];
  refreshPages(channel?: string): Promise<readonly SessionRefreshResult[]>;
  captureScreenshot(channel?: string): Promise<SessionScreenshot | undefined>;
  getConfig(): RuntimeWatchConfig;
  setChannels(channels: readonly string[]): Promise<RuntimeWatchConfig>;
  setMaxConcurrentStreams(value: number): Promise<RuntimeWatchConfig>;
}
