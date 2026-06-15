import type { BrowserManager } from '../browser/index.js';
import type { Logger } from '../logging/index.js';
import type { SessionManager } from '../sessions/index.js';
import type { ApplicationIntegration } from './AppRunner.js';

export interface RuntimeResourceMonitorOptions {
  readonly browserManager: Pick<BrowserManager, 'getPageCount'>;
  readonly sessionManager: Pick<SessionManager, 'getActiveChannels'>;
  readonly logger: Pick<Logger, 'info'>;
  readonly intervalSeconds: number;
}

export class RuntimeResourceMonitor implements ApplicationIntegration {
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly options: RuntimeResourceMonitorOptions) {
    if (
      !Number.isSafeInteger(options.intervalSeconds) ||
      options.intervalSeconds <= 0
    ) {
      throw new TypeError('intervalSeconds must be a positive integer');
    }
  }

  public async start(): Promise<void> {
    if (this.timer !== undefined) {
      return;
    }
    this.recordSnapshot();
    this.timer = setInterval(
      () => {
        this.recordSnapshot();
      },
      Math.min(
        2_147_483_647,
        this.options.intervalSeconds * 1_000,
      ),
    );
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private recordSnapshot(): void {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const resources = process.resourceUsage();
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
    });
  }
}
