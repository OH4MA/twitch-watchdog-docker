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

export interface TelegramApi {
  getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<readonly TelegramUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
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

  public async sendMessage(chatId: string, text: string): Promise<void> {
    await this.call<unknown>('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4_096),
    }, AbortSignal.timeout(SEND_TIMEOUT_MS));
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
}
