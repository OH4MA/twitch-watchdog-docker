export interface TelegramMessage {
  readonly message_id: number;
  readonly text?: string;
  readonly chat: {
    readonly id: number | string;
  };
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

export interface TelegramReplyKeyboardMarkup {
  readonly keyboard: readonly (readonly {
    readonly text: string;
  }[])[];
  readonly is_persistent?: boolean;
  readonly resize_keyboard?: boolean;
}

export interface TelegramSendMessageOptions {
  readonly reply_markup?: TelegramReplyKeyboardMarkup;
}

export interface TelegramApi {
  getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<readonly TelegramUpdate[]>;
  setMyCommands(commands: readonly TelegramBotCommand[]): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    options?: TelegramSendMessageOptions,
  ): Promise<void>;
  sendPhoto(
    chatId: string,
    image: Buffer,
    filename: string,
    caption: string,
  ): Promise<void>;
}

export interface TelegramApiClientOptions {
  readonly botToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface TelegramResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
}

const SEND_TIMEOUT_MS = 10_000;

export class TelegramApiError extends Error {
  public constructor(
    public readonly method: string,
    message = 'Telegram API request failed',
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export class TelegramApiClient implements TelegramApi {
  private readonly fetch: typeof globalThis.fetch;

  public constructor(private readonly options: TelegramApiClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  public async getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<readonly TelegramUpdate[]> {
    return this.call<readonly TelegramUpdate[]>(
      'getUpdates',
      {
        ...(offset === undefined ? {} : { offset }),
        timeout: timeoutSeconds,
        allowed_updates: ['message'],
      },
      signal,
    );
  }

  public async setMyCommands(
    commands: readonly TelegramBotCommand[],
  ): Promise<void> {
    await this.call<unknown>(
      'setMyCommands',
      { commands },
      AbortSignal.timeout(SEND_TIMEOUT_MS),
    );
  }

  public async sendMessage(
    chatId: string,
    text: string,
    options: TelegramSendMessageOptions = {},
  ): Promise<void> {
    await this.call<unknown>('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4_096),
      ...options,
    }, AbortSignal.timeout(SEND_TIMEOUT_MS));
  }

  public async sendPhoto(
    chatId: string,
    image: Buffer,
    filename: string,
    caption: string,
  ): Promise<void> {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('caption', caption.slice(0, 1_024));
    form.set(
      'photo',
      new Blob([new Uint8Array(image)], { type: 'image/png' }),
      filename,
    );
    await this.callForm<unknown>(
      'sendPhoto',
      form,
      AbortSignal.timeout(SEND_TIMEOUT_MS),
    );
  }

  private async call<T>(
    method: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;

    try {
      response = await this.fetch(
        `https://api.telegram.org/bot${this.options.botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        throw error;
      }
      throw new TelegramApiError(method, 'Telegram network request failed');
    }

    let payload: TelegramResponse<T>;
    try {
      payload = await response.json() as TelegramResponse<T>;
    } catch {
      throw new TelegramApiError(method, 'Telegram returned invalid JSON');
    }

    if (!response.ok || payload.ok !== true || payload.result === undefined) {
      throw new TelegramApiError(
        method,
        payload.description === undefined
          ? `Telegram API returned HTTP ${response.status}`
          : `Telegram API rejected ${method}`,
      );
    }

    return payload.result;
  }

  private async callForm<T>(
    method: string,
    body: FormData,
    signal: AbortSignal,
  ): Promise<T> {
    let response: Response;

    try {
      response = await this.fetch(
        `https://api.telegram.org/bot${this.options.botToken}/${method}`,
        {
          method: 'POST',
          body,
          redirect: 'error',
          signal,
        },
      );
    } catch (error: unknown) {
      if (signal.aborted) {
        throw error;
      }
      throw new TelegramApiError(method, 'Telegram network request failed');
    }

    return parseTelegramResponse<T>(response, method);
  }
}

async function parseTelegramResponse<T>(
  response: Response,
  method: string,
): Promise<T> {
  let payload: TelegramResponse<T>;
  try {
    payload = await response.json() as TelegramResponse<T>;
  } catch {
    throw new TelegramApiError(method, 'Telegram returned invalid JSON');
  }

  if (!response.ok || payload.ok !== true || payload.result === undefined) {
    throw new TelegramApiError(
      method,
      payload.description === undefined
        ? `Telegram API returned HTTP ${response.status}`
        : `Telegram API rejected ${method}`,
    );
  }

  return payload.result;
}
