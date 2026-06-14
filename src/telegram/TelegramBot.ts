import type { RewardClaimResult } from '../browser/index.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/index.js';
import type {
  StreamStatusChange,
  WatchdogScheduler,
} from '../scheduler/index.js';
import type { SessionManager } from '../sessions/index.js';
import type {
  TelegramApi,
  TelegramUpdate,
} from './TelegramApiClient.js';

export interface TelegramBot {
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
  notifyStreamStatus(change: StreamStatusChange): Promise<void>;
  notifyReward(result: RewardClaimResult): Promise<void>;
}

export interface TelegramBotOptions {
  readonly config: AppConfig;
  readonly api: TelegramApi;
  readonly scheduler: WatchdogScheduler;
  readonly sessionManager: SessionManager;
  readonly logger: Logger;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_SLEEP = async (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  await new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(handle);
        resolve();
      },
      { once: true },
    );
  });
};

export class DefaultTelegramBot implements TelegramBot {
  private readonly allowedChatIds: ReadonlySet<string>;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private abortController: AbortController | undefined;
  private pollingFlight: Promise<void> | undefined;
  private offset: number | undefined;
  private started = false;

  public constructor(private readonly options: TelegramBotOptions) {
    this.allowedChatIds = new Set(
      options.config.telegram.allowedChatIds,
    );
    this.sleep = options.sleep ?? DEFAULT_SLEEP;
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.abortController = new AbortController();
    await this.broadcast(this.formatServiceStarted());
    this.pollingFlight = this.poll(this.abortController.signal);
  }

  public async stop(reason: string): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    const controller = this.abortController;
    const pollingFlight = this.pollingFlight;
    this.abortController = undefined;
    this.pollingFlight = undefined;

    controller?.abort();
    await pollingFlight;
    await this.broadcast(`Twitch Watchdog 已停止\n原因：${reason}`);
  }

  public notifyStreamStatus(change: StreamStatusChange): Promise<void> {
    return this.broadcast(
      change.isLive
        ? `🔴 ${change.channel} 已開台`
        : `⚫ ${change.channel} 已離線`,
    );
  }

  public notifyReward(result: RewardClaimResult): Promise<void> {
    if (result.status === 'claimed') {
      return this.broadcast(`🎁 ${result.channel} 已領取忠誠點數`);
    }
    if (result.status === 'click_failed') {
      return this.broadcast(`⚠️ ${result.channel} 忠誠點數領取失敗`);
    }
    return Promise.resolve();
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failureCount = 0;

    while (!signal.aborted) {
      try {
        const updates = await this.options.api.getUpdates(
          this.offset,
          this.options.config.telegram.pollingTimeoutSeconds,
          signal,
        );
        failureCount = 0;
        for (const update of updates) {
          this.offset = Math.max(
            this.offset ?? 0,
            update.update_id + 1,
          );
          try {
            await this.handleUpdate(update);
          } catch {
            this.options.logger.warn('telegram_command_failed', {
              updateId: update.update_id,
            });
          }
        }
      } catch {
        if (signal.aborted) {
          return;
        }
        failureCount += 1;
        this.options.logger.warn('telegram_poll_failed', {
          retryInMs: Math.min(30_000, 1_000 * 2 ** (failureCount - 1)),
        });
        await this.sleep(
          Math.min(30_000, 1_000 * 2 ** (failureCount - 1)),
          signal,
        );
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (message?.text === undefined) {
      return;
    }

    const chatId = String(message.chat.id);
    if (!this.allowedChatIds.has(chatId)) {
      this.options.logger.warn('telegram_unauthorized_chat', { chatId });
      return;
    }

    const command = parseCommand(message.text);
    if (command === undefined) {
      return;
    }

    await this.handleCommand(chatId, command);
  }

  private async handleCommand(
    chatId: string,
    command: string,
  ): Promise<void> {
    switch (command) {
      case 'start':
      case 'help':
        await this.options.api.sendMessage(chatId, HELP_TEXT);
        return;
      case 'status':
        await this.options.api.sendMessage(chatId, this.formatStatus());
        return;
      case 'channels':
        await this.options.api.sendMessage(
          chatId,
          this.formatChannels(),
        );
        return;
      case 'check':
        await this.options.scheduler.runOnce();
        await this.options.api.sendMessage(chatId, '已完成一次狀態檢查。');
        return;
      case 'pause':
        await this.options.scheduler.stop();
        await this.options.api.sendMessage(chatId, '自動檢查已暫停。');
        return;
      case 'resume':
        this.options.scheduler.start();
        await this.options.api.sendMessage(chatId, '自動檢查已恢復。');
        return;
      default:
        await this.options.api.sendMessage(
          chatId,
          `不支援的指令：/${command}\n\n${HELP_TEXT}`,
        );
    }
  }

  private formatServiceStarted(): string {
    return [
      'Twitch Watchdog 已啟動',
      `監控頻道：${this.options.config.channels.length}`,
      `最大同時觀看：${this.options.config.maxConcurrentStreams}`,
    ].join('\n');
  }

  private formatStatus(): string {
    const snapshot = this.options.scheduler.getSnapshot();
    const activeChannels = this.options.sessionManager.getActiveChannels();
    const liveChannels = snapshot.channels
      .filter((channel) => channel.isLive === true)
      .map((channel) => channel.channel);

    return [
      `自動檢查：${snapshot.running ? '執行中' : '已暫停'}`,
      `檢查進行中：${snapshot.checkInFlight ? '是' : '否'}`,
      `上次完成：${snapshot.lastCheckedAt ?? '尚未完成'}`,
      `限流重試：${snapshot.retryAt ?? '無'}`,
      `目前開台：${formatList(liveChannels)}`,
      `正在觀看：${formatList(activeChannels)}`,
    ].join('\n');
  }

  private formatChannels(): string {
    const snapshot = this.options.scheduler.getSnapshot();
    return snapshot.channels
      .map((status, index) => {
        const marker = status.isLive === true
          ? '🔴'
          : status.isLive === false
            ? '⚫'
            : '❔';
        return `${index + 1}. ${marker} ${status.channel}`;
      })
      .join('\n');
  }

  private async broadcast(text: string): Promise<void> {
    for (const chatId of this.allowedChatIds) {
      try {
        await this.options.api.sendMessage(chatId, text);
      } catch {
        this.options.logger.warn('telegram_send_failed', { chatId });
      }
    }
  }
}

const HELP_TEXT = [
  '可用指令：',
  '/status - 顯示服務與觀看狀態',
  '/channels - 顯示監控頻道',
  '/check - 立即檢查一次',
  '/pause - 暫停自動檢查',
  '/resume - 恢復自動檢查',
  '/help - 顯示說明',
].join('\n');

function parseCommand(text: string): string | undefined {
  const firstToken = text.trim().split(/\s+/u)[0];
  if (firstToken === undefined || !firstToken.startsWith('/')) {
    return undefined;
  }
  return firstToken.slice(1).split('@', 1)[0]?.toLocaleLowerCase('en-US');
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? '無' : values.join('、');
}
