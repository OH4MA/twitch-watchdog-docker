import type {
  ChannelSessionRefreshEvent,
  RewardClaimResult,
} from '../browser/index.js';
import type { AppConfig } from '../config/index.js';
import { ConfigValidationError } from '../config/index.js';
import type { Logger } from '../logging/index.js';
import type { BotCommandContext } from '../notifications/BotCommandContext.js';
import type { StreamStatusChange } from '../scheduler/index.js';
import type {
  DiscordApi,
  DiscordApplicationCommand,
} from './DiscordApiClient.js';

export interface DiscordBot {
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
  notifyStreamStatus(change: StreamStatusChange): Promise<void>;
  notifyReward(result: RewardClaimResult): Promise<void>;
  notifyPageRefresh(event: ChannelSessionRefreshEvent): Promise<void>;
}

export interface DiscordGatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: DiscordGatewayEvent) => void,
  ): void;
}

export interface DiscordGatewayEvent {
  readonly data?: unknown;
}

export type DiscordGatewayFactory = (url: string) => DiscordGatewaySocket;

export interface DiscordBotOptions {
  readonly config: AppConfig;
  readonly api: DiscordApi;
  readonly commandContext: BotCommandContext;
  readonly logger: Logger;
  readonly gatewayFactory?: DiscordGatewayFactory;
  readonly timer?: DiscordBotTimer;
}

export interface DiscordBotTimer {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

interface DiscordGatewayPayload {
  readonly op: number;
  readonly d?: unknown;
  readonly s?: number | null;
  readonly t?: string | null;
}

interface DiscordHelloPayload {
  readonly heartbeat_interval: number;
}

interface DiscordInteraction {
  readonly id: string;
  readonly token: string;
  readonly channel_id?: string;
  readonly guild_id?: string;
  readonly type: number;
  readonly user?: DiscordUser;
  readonly member?: {
    readonly user?: DiscordUser;
  };
  readonly data?: {
    readonly name?: string;
    readonly options?: readonly DiscordInteractionOption[];
  };
}

interface DiscordUser {
  readonly id: string;
}

interface DiscordInteractionOption {
  readonly name: string;
  readonly value?: string | number;
}

interface ParsedCommand {
  readonly command: string;
  readonly argument?: string;
}

const DEFAULT_TIMER: DiscordBotTimer = {
  setInterval(callback: () => void, milliseconds: number): unknown {
    return globalThis.setInterval(callback, milliseconds);
  },
  clearInterval(handle: unknown): void {
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

const OPCODE_DISPATCH = 0;
const OPCODE_HEARTBEAT = 1;
const OPCODE_IDENTIFY = 2;
const OPCODE_HELLO = 10;
const DISCORD_APPLICATION_COMMAND_INTERACTION = 2;

export class DefaultDiscordBot implements DiscordBot {
  private readonly allowedChannelIds: ReadonlySet<string>;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly gatewayFactory: DiscordGatewayFactory;
  private readonly timer: DiscordBotTimer;
  private socket: DiscordGatewaySocket | undefined;
  private heartbeatHandle: unknown;
  private sequence: number | null = null;
  private started = false;

  public constructor(private readonly options: DiscordBotOptions) {
    this.allowedChannelIds = new Set(
      options.config.discord.allowedChannelIds,
    );
    this.allowedUserIds = new Set(
      options.config.discord.allowedUserIds,
    );
    this.gatewayFactory = options.gatewayFactory ?? createWebSocket;
    this.timer = options.timer ?? DEFAULT_TIMER;
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    try {
      await this.options.api.registerCommands(
        this.options.config.discord.applicationId,
        this.options.config.discord.guildId,
        BOT_COMMANDS,
      );
    } catch {
      this.options.logger.warn('discord_command_registration_failed');
    }

    const gateway = await this.options.api.getGatewayBot(
      AbortSignal.timeout(10_000),
    );
    this.socket = this.gatewayFactory(`${gateway.url}?v=10&encoding=json`);
    this.socket.addEventListener('open', () => this.identify());
    this.socket.addEventListener('message', (event) => {
      void this.handleGatewayMessage(event.data).catch(() => {
        this.options.logger.warn('discord_gateway_message_failed');
      });
    });
    this.socket.addEventListener('close', () => this.clearHeartbeat());
    this.socket.addEventListener('error', () => {
      this.options.logger.warn('discord_gateway_error');
    });

    await this.broadcast(this.formatServiceStarted());
  }

  public async stop(reason: string): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.clearHeartbeat();
    this.socket?.close(1000, reason);
    this.socket = undefined;
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

  public notifyPageRefresh(
    event: ChannelSessionRefreshEvent,
  ): Promise<void> {
    return this.broadcast(`🔄 ${event.channel} 正在重整 Twitch 播放器`);
  }

  private identify(): void {
    this.sendGateway({
      op: OPCODE_IDENTIFY,
      d: {
        token: this.options.config.discord.botToken,
        intents: 0,
        properties: {
          os: process.platform,
          browser: 'twitch-watchdog',
          device: 'twitch-watchdog',
        },
      },
    });
  }

  private async handleGatewayMessage(data: unknown): Promise<void> {
    const payload = parseGatewayPayload(data);
    if (payload === undefined) {
      return;
    }
    if (payload.s !== undefined) {
      this.sequence = payload.s;
    }

    if (payload.op === OPCODE_HELLO) {
      const hello = payload.d;
      if (isDiscordHelloPayload(hello)) {
        this.startHeartbeat(hello.heartbeat_interval);
      }
      return;
    }

    if (
      payload.op === OPCODE_DISPATCH &&
      payload.t === 'INTERACTION_CREATE' &&
      isDiscordInteraction(payload.d)
    ) {
      await this.handleInteraction(payload.d);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatHandle = this.timer.setInterval(
      () => this.sendHeartbeat(),
      intervalMs,
    );
    this.sendHeartbeat();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatHandle !== undefined) {
      this.timer.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }
  }

  private sendHeartbeat(): void {
    this.sendGateway({ op: OPCODE_HEARTBEAT, d: this.sequence });
  }

  private sendGateway(payload: Readonly<Record<string, unknown>>): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private async handleInteraction(
    interaction: DiscordInteraction,
  ): Promise<void> {
    if (interaction.type !== DISCORD_APPLICATION_COMMAND_INTERACTION) {
      return;
    }
    const authorization = this.authorizeInteraction(interaction);
    if (!authorization.allowed) {
      this.options.logger.warn(authorization.event, authorization.fields);
      await this.reply(interaction, authorization.message);
      return;
    }

    const parsed = parseInteractionCommand(interaction);
    if (parsed === undefined) {
      return;
    }
    await this.handleCommand(interaction, parsed.command, parsed.argument);
  }

  private authorizeInteraction(
    interaction: DiscordInteraction,
  ):
    | { readonly allowed: true }
    | {
        readonly allowed: false;
        readonly event: string;
        readonly fields: Readonly<Record<string, unknown>>;
        readonly message: string;
      } {
    if (interaction.guild_id === undefined) {
      const userId = interaction.user?.id ?? interaction.member?.user?.id;
      if (
        this.options.config.discord.allowDirectMessages &&
        userId !== undefined &&
        this.allowedUserIds.has(userId)
      ) {
        return { allowed: true };
      }
      return {
        allowed: false,
        event: 'discord_unauthorized_dm_user',
        fields: { userId },
        message: '這個 Discord 使用者未被允許透過私訊控制服務。',
      };
    }

    const channelId = interaction.channel_id;
    if (
      channelId !== undefined &&
      this.allowedChannelIds.has(channelId)
    ) {
      return { allowed: true };
    }

    return {
      allowed: false,
      event: 'discord_unauthorized_channel',
      fields: { channelId },
      message: '這個 Discord channel 未被允許使用。',
    };
  }

  private async handleCommand(
    interaction: DiscordInteraction,
    command: string,
    argument: string | undefined,
  ): Promise<void> {
    switch (command) {
      case 'help':
        await this.reply(interaction, HELP_TEXT);
        return;
      case 'status':
        await this.reply(interaction, this.formatStatus());
        return;
      case 'channels':
        await this.reply(interaction, this.formatChannels());
        return;
      case 'refresh':
        await this.reply(interaction, this.formatRefreshCountdown());
        return;
      case 'refresh_now':
        await this.defer(interaction);
        await this.refreshPages(interaction, argument);
        return;
      case 'config':
        await this.reply(interaction, this.formatRuntimeConfig());
        return;
      case 'channel_add':
        await this.defer(interaction);
        await this.runConfigCommand(
          interaction,
          () => this.addChannel(interaction, argument),
        );
        return;
      case 'channel_remove':
        await this.defer(interaction);
        await this.runConfigCommand(
          interaction,
          () => this.removeChannel(interaction, argument),
        );
        return;
      case 'channels_set':
        await this.defer(interaction);
        await this.runConfigCommand(
          interaction,
          () => this.setChannels(interaction, argument),
        );
        return;
      case 'max_streams':
        await this.defer(interaction);
        await this.runConfigCommand(
          interaction,
          () => this.setMaxStreams(interaction, argument),
        );
        return;
      case 'check':
        await this.defer(interaction);
        await this.options.commandContext.runCheck();
        await this.editReply(interaction, '已完成一次狀態檢查。');
        return;
      case 'pause':
        await this.options.commandContext.pauseChecks();
        await this.reply(interaction, '自動檢查已暫停。');
        return;
      case 'resume':
        this.options.commandContext.resumeChecks();
        await this.reply(interaction, '自動檢查已恢復。');
        return;
      case 'screenshot':
        await this.defer(interaction);
        await this.sendScreenshot(interaction, argument);
        return;
      default:
        await this.reply(
          interaction,
          `不支援的指令：/${command}\n\n${HELP_TEXT}`,
        );
    }
  }

  private async sendScreenshot(
    interaction: DiscordInteraction,
    requestedChannel: string | undefined,
  ): Promise<void> {
    if (requestedChannel === undefined) {
      const activeChannels = this.options.commandContext.getActiveChannels();
      if (activeChannels.length === 0) {
        await this.editReply(interaction, '目前沒有正在觀看的頻道可供截圖。');
        return;
      }

      await this.editReply(interaction, '正在傳送截圖。');
      let sentCount = 0;
      for (const channel of activeChannels) {
        const screenshot =
          await this.options.commandContext.captureScreenshot(channel);
        if (screenshot === undefined) {
          continue;
        }
        await this.sendInteractionScreenshot(interaction, screenshot);
        sentCount += 1;
      }
      if (sentCount === 0) {
        await this.editReply(interaction, '目前沒有正在觀看的頻道可供截圖。');
      }
      return;
    }

    const screenshot = await this.options.commandContext.captureScreenshot(
      requestedChannel,
    );
    if (screenshot === undefined) {
      const activeChannels = this.options.commandContext.getActiveChannels();
      await this.editReply(
        interaction,
        activeChannels.length === 0
          ? '目前沒有正在觀看的頻道可供截圖。'
          : [
              `找不到正在觀看的頻道：${requestedChannel}`,
              `可用頻道：${activeChannels.join('、')}`,
            ].join('\n'),
      );
      return;
    }

    await this.editReply(interaction, '正在傳送截圖。');
    await this.sendInteractionScreenshot(interaction, screenshot);
  }

  private async refreshPages(
    interaction: DiscordInteraction,
    requestedChannel: string | undefined,
  ): Promise<void> {
    const results =
      await this.options.commandContext.refreshPages(requestedChannel);
    if (results.length === 0) {
      const activeChannels = this.options.commandContext.getActiveChannels();
      await this.editReply(
        interaction,
        activeChannels.length === 0
          ? '目前沒有正在觀看的頻道可重整。'
          : [
              `找不到正在觀看的頻道：${requestedChannel ?? ''}`,
              `可用頻道：${activeChannels.join('、')}`,
            ].join('\n'),
      );
      return;
    }

    await this.editReply(
      interaction,
      [
        '手動重整結果：',
        ...results.map((result, index) => {
          if (result.status === 'refreshed') {
            return `${index + 1}. ${result.channel}：已重整`;
          }
          if (result.status === 'unavailable') {
            return `${index + 1}. ${result.channel}：目前無法重整`;
          }
          return `${index + 1}. ${result.channel}：重整失敗`;
        }),
      ].join('\n'),
    );
  }

  private async sendInteractionScreenshot(
    interaction: DiscordInteraction,
    screenshot: {
      readonly channel: string;
      readonly image: Buffer;
    },
  ): Promise<void> {
    await this.options.api.sendInteractionPhoto(
      this.options.config.discord.applicationId,
      interaction.token,
      screenshot.image,
      `${screenshot.channel}.png`,
      `${screenshot.channel} 目前瀏覽器畫面`,
    );
    this.options.logger.info('discord_screenshot_sent', {
      channel: screenshot.channel,
      bytes: screenshot.image.byteLength,
    });
  }

  private async addChannel(
    interaction: DiscordInteraction,
    argument: string | undefined,
  ): Promise<void> {
    if (argument === undefined) {
      await this.editReply(interaction, '用法：/channel_add 頻道名稱');
      return;
    }
    const current = this.options.commandContext.getConfig();
    if (
      current.channels.some(
        (channel) =>
          channel.toLocaleLowerCase('en-US') ===
          argument.toLocaleLowerCase('en-US'),
      )
    ) {
      await this.editReply(interaction, `頻道已在監控清單中：${argument}`);
      return;
    }
    const updated = await this.options.commandContext.setChannels([
      ...current.channels,
      argument,
    ]);
    await this.editReply(
      interaction,
      `已加入頻道：${argument}\n${formatRuntimeConfig(updated)}`,
    );
  }

  private async runConfigCommand(
    interaction: DiscordInteraction,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error: unknown) {
      this.options.logger.warn('discord_config_update_failed', {
        errorType:
          error instanceof Error ? error.name : 'UnknownError',
      });
      await this.editReply(
        interaction,
        error instanceof ConfigValidationError
          ? error.message
          : '設定更新失敗，請確認 config.yml 可寫入。',
      );
    }
  }

  private async removeChannel(
    interaction: DiscordInteraction,
    argument: string | undefined,
  ): Promise<void> {
    if (argument === undefined) {
      await this.editReply(interaction, '用法：/channel_remove 頻道名稱');
      return;
    }
    const current = this.options.commandContext.getConfig();
    const normalized = argument.toLocaleLowerCase('en-US');
    const channels = current.channels.filter(
      (channel) =>
        channel.toLocaleLowerCase('en-US') !== normalized,
    );
    if (channels.length === current.channels.length) {
      await this.editReply(interaction, `找不到監控頻道：${argument}`);
      return;
    }
    const updated =
      await this.options.commandContext.setChannels(channels);
    await this.editReply(
      interaction,
      `已移除頻道：${argument}\n${formatRuntimeConfig(updated)}`,
    );
  }

  private async setChannels(
    interaction: DiscordInteraction,
    argument: string | undefined,
  ): Promise<void> {
    const channels = parseChannelsArgument(argument);
    if (channels.length === 0) {
      await this.editReply(interaction, '用法：/channels_set 頻道一,頻道二');
      return;
    }
    const updated =
      await this.options.commandContext.setChannels(channels);
    await this.editReply(
      interaction,
      `頻道清單已更新\n${formatRuntimeConfig(updated)}`,
    );
  }

  private async setMaxStreams(
    interaction: DiscordInteraction,
    argument: string | undefined,
  ): Promise<void> {
    const value = Number(argument);
    if (
      argument === undefined ||
      !/^\d+$/u.test(argument) ||
      !Number.isSafeInteger(value)
    ) {
      await this.editReply(interaction, '用法：/max_streams 正整數');
      return;
    }
    const updated =
      await this.options.commandContext.setMaxConcurrentStreams(value);
    await this.editReply(
      interaction,
      `最大同時觀看已更新為 ${value}\n${formatRuntimeConfig(updated)}`,
    );
  }

  private formatServiceStarted(): string {
    return [
      'Twitch Watchdog 已啟動',
      `監控頻道：${this.options.config.channels.length}`,
      `最大同時觀看：${this.options.config.maxConcurrentStreams}`,
    ].join('\n');
  }

  private formatStatus(): string {
    const snapshot = this.options.commandContext.getSchedulerSnapshot();
    const activeChannels = this.options.commandContext.getActiveChannels();
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
    const snapshot = this.options.commandContext.getSchedulerSnapshot();
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

  private formatRefreshCountdown(): string {
    const statuses = this.options.commandContext.getRefreshStatuses();
    if (statuses.length === 0) {
      return '目前沒有正在觀看的頻道。';
    }

    return [
      '重整倒數：',
      ...statuses.map((status, index) => {
        if (!status.enabled) {
          return `${index + 1}. ${status.channel}：已關閉定時重整`;
        }
        if (
          status.nextRefreshAt === undefined ||
          status.secondsUntilRefresh === undefined
        ) {
          return `${index + 1}. ${status.channel}：重整排程準備中`;
        }
        return [
          `${index + 1}. ${status.channel}：`,
          `${formatDuration(status.secondsUntilRefresh)}後`,
          `（下次：${status.nextRefreshAt}）`,
        ].join('');
      }),
    ].join('\n');
  }

  private formatRuntimeConfig(): string {
    return formatRuntimeConfig(
      this.options.commandContext.getConfig(),
    );
  }

  private async reply(
    interaction: DiscordInteraction,
    text: string,
  ): Promise<void> {
    await this.options.api.sendInteractionResponse(
      interaction.id,
      interaction.token,
      text,
    );
  }

  private async defer(interaction: DiscordInteraction): Promise<void> {
    await this.options.api.deferInteractionResponse(
      interaction.id,
      interaction.token,
    );
  }

  private async editReply(
    interaction: DiscordInteraction,
    text: string,
  ): Promise<void> {
    await this.options.api.editInteractionResponse(
      this.options.config.discord.applicationId,
      interaction.token,
      text,
    );
  }

  private async broadcast(text: string): Promise<void> {
    for (const channelId of this.allowedChannelIds) {
      try {
        await this.options.api.sendMessage(channelId, text);
      } catch {
        this.options.logger.warn('discord_send_failed', { channelId });
      }
    }
  }
}

const HELP_TEXT = [
  '可用指令：',
  '/status - 顯示服務與觀看狀態',
  '/channels - 顯示監控頻道',
  '/refresh - 顯示 Twitch 播放器重整倒數',
  '/refresh_now [頻道] - 立即重整全部或指定觀看頁',
  '/config - 顯示可調整的設定',
  '/channel_add 頻道 - 新增監控頻道',
  '/channel_remove 頻道 - 移除監控頻道',
  '/channels_set 頻道一,頻道二 - 取代頻道清單',
  '/max_streams 數量 - 設定最大同時觀看',
  '/check - 立即檢查一次',
  '/pause - 暫停自動檢查',
  '/resume - 恢復自動檢查',
  '/screenshot [頻道] - 回傳全部或指定頻道畫面',
  '/help - 顯示說明',
].join('\n');

const BOT_COMMANDS: readonly DiscordApplicationCommand[] = Object.freeze([
  { name: 'status', description: '顯示服務與觀看狀態' },
  { name: 'channels', description: '顯示監控頻道' },
  { name: 'refresh', description: '顯示播放器重整倒數' },
  {
    name: 'refresh_now',
    description: '立即重整觀看頁',
    options: [{
      type: 3,
      name: 'channel',
      description: 'Twitch 頻道名稱',
    }],
  },
  { name: 'config', description: '顯示頻道與同時觀看設定' },
  {
    name: 'channel_add',
    description: '新增監控頻道',
    options: [{
      type: 3,
      name: 'channel',
      description: 'Twitch 頻道名稱',
      required: true,
    }],
  },
  {
    name: 'channel_remove',
    description: '移除監控頻道',
    options: [{
      type: 3,
      name: 'channel',
      description: 'Twitch 頻道名稱',
      required: true,
    }],
  },
  {
    name: 'channels_set',
    description: '取代監控頻道清單',
    options: [{
      type: 3,
      name: 'channels',
      description: '以逗號或空白分隔的 Twitch 頻道名稱',
      required: true,
    }],
  },
  {
    name: 'max_streams',
    description: '設定最大同時觀看',
    options: [{
      type: 4,
      name: 'count',
      description: '最大同時觀看數量',
      required: true,
    }],
  },
  { name: 'check', description: '立即檢查一次' },
  { name: 'pause', description: '暫停自動檢查' },
  { name: 'resume', description: '恢復自動檢查' },
  {
    name: 'screenshot',
    description: '擷取目前觀看畫面',
    options: [{
      type: 3,
      name: 'channel',
      description: 'Twitch 頻道名稱',
    }],
  },
  { name: 'help', description: '顯示指令說明' },
]);

function parseInteractionCommand(
  interaction: DiscordInteraction,
): ParsedCommand | undefined {
  const command = interaction.data?.name?.toLocaleLowerCase('en-US');
  if (command === undefined || command === '') {
    return undefined;
  }
  const firstValue = interaction.data?.options?.[0]?.value;
  return {
    command,
    ...(firstValue === undefined
      ? {}
      : { argument: String(firstValue).trim() }),
  };
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? '無' : values.join('、');
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds} 秒`;
  }
  if (remainingSeconds === 0) {
    return `${minutes} 分鐘`;
  }
  return `${minutes} 分 ${remainingSeconds} 秒`;
}

function parseChannelsArgument(argument: string | undefined): string[] {
  return argument === undefined
    ? []
    : argument.split(/[\s,]+/u).filter((channel) => channel !== '');
}

function formatRuntimeConfig(config: {
  readonly channels: readonly string[];
  readonly maxConcurrentStreams: number;
}): string {
  return [
    `監控頻道：${config.channels.join('、')}`,
    `最大同時觀看：${config.maxConcurrentStreams}`,
  ].join('\n');
}

function parseGatewayPayload(data: unknown): DiscordGatewayPayload | undefined {
  if (typeof data !== 'string') {
    return undefined;
  }
  try {
    const payload = JSON.parse(data) as unknown;
    return isDiscordGatewayPayload(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function isDiscordGatewayPayload(
  value: unknown,
): value is DiscordGatewayPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DiscordGatewayPayload).op === 'number'
  );
}

function isDiscordHelloPayload(
  value: unknown,
): value is DiscordHelloPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DiscordHelloPayload).heartbeat_interval === 'number'
  );
}

function isDiscordInteraction(
  value: unknown,
): value is DiscordInteraction {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const interaction = value as DiscordInteraction;
  return (
    typeof interaction.id === 'string' &&
    typeof interaction.token === 'string' &&
    typeof interaction.type === 'number'
  );
}

function createWebSocket(url: string): DiscordGatewaySocket {
  const WebSocketConstructor = (
    globalThis as typeof globalThis & {
      WebSocket?: new (target: string) => DiscordGatewaySocket;
    }
  ).WebSocket;
  if (WebSocketConstructor === undefined) {
    throw new Error('WebSocket is not available in this Node.js runtime');
  }
  return new WebSocketConstructor(url);
}
