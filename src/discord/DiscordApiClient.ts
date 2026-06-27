export interface DiscordApplicationCommandOption {
  readonly type: 3 | 4;
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
}

export interface DiscordApplicationCommand {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly DiscordApplicationCommandOption[];
}

export interface DiscordGatewayBot {
  readonly id: string;
  readonly username: string;
}

export interface DiscordGatewayResponse {
  readonly url: string;
}

export interface DiscordApi {
  getGatewayBot(signal: AbortSignal): Promise<DiscordGatewayResponse>;
  registerCommands(
    applicationId: string,
    guildId: string,
    commands: readonly DiscordApplicationCommand[],
  ): Promise<void>;
  sendMessage(channelId: string, content: string): Promise<void>;
  sendInteractionResponse(
    interactionId: string,
    interactionToken: string,
    content: string,
  ): Promise<void>;
  deferInteractionResponse(
    interactionId: string,
    interactionToken: string,
  ): Promise<void>;
  editInteractionResponse(
    applicationId: string,
    interactionToken: string,
    content: string,
  ): Promise<void>;
  sendInteractionPhoto(
    applicationId: string,
    interactionToken: string,
    image: Buffer,
    filename: string,
    content: string,
  ): Promise<void>;
}

export interface DiscordApiClientOptions {
  readonly botToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface DiscordErrorPayload {
  readonly message?: string;
}

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const SEND_TIMEOUT_MS = 10_000;
const INTERACTION_CALLBACK_CHANNEL_MESSAGE = 4;
const INTERACTION_CALLBACK_DEFERRED_CHANNEL_MESSAGE = 5;

export class DiscordApiError extends Error {
  public constructor(
    public readonly method: string,
    message = 'Discord API request failed',
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

export class DiscordApiClient implements DiscordApi {
  private readonly fetch: typeof globalThis.fetch;

  public constructor(private readonly options: DiscordApiClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  public async getGatewayBot(
    signal: AbortSignal,
  ): Promise<DiscordGatewayResponse> {
    return this.call<DiscordGatewayResponse>(
      'GET',
      '/gateway/bot',
      undefined,
      signal,
    );
  }

  public async registerCommands(
    applicationId: string,
    guildId: string,
    commands: readonly DiscordApplicationCommand[],
  ): Promise<void> {
    const route = guildId === ''
      ? `/applications/${applicationId}/commands`
      : `/applications/${applicationId}/guilds/${guildId}/commands`;
    await this.call<unknown>(
      'PUT',
      route,
      commands,
      AbortSignal.timeout(SEND_TIMEOUT_MS),
    );
  }

  public async sendMessage(
    channelId: string,
    content: string,
  ): Promise<void> {
    await this.call<unknown>(
      'POST',
      `/channels/${channelId}/messages`,
      { content: content.slice(0, 2_000) },
      AbortSignal.timeout(SEND_TIMEOUT_MS),
    );
  }

  public async sendInteractionResponse(
    interactionId: string,
    interactionToken: string,
    content: string,
  ): Promise<void> {
    await this.call<unknown>(
      'POST',
      `/interactions/${interactionId}/${interactionToken}/callback`,
      {
        type: INTERACTION_CALLBACK_CHANNEL_MESSAGE,
        data: { content: content.slice(0, 2_000) },
      },
      AbortSignal.timeout(SEND_TIMEOUT_MS),
    );
  }

  public async deferInteractionResponse(
    interactionId: string,
    interactionToken: string,
  ): Promise<void> {
    await this.call<unknown>(
      'POST',
      `/interactions/${interactionId}/${interactionToken}/callback`,
      { type: INTERACTION_CALLBACK_DEFERRED_CHANNEL_MESSAGE },
      AbortSignal.timeout(SEND_TIMEOUT_MS),
    );
  }

  public async editInteractionResponse(
    applicationId: string,
    interactionToken: string,
    content: string,
  ): Promise<void> {
    await this.call<unknown>(
      'PATCH',
      `/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      { content: content.slice(0, 2_000) },
      AbortSignal.timeout(SEND_TIMEOUT_MS),
      false,
    );
  }

  public async sendInteractionPhoto(
    applicationId: string,
    interactionToken: string,
    image: Buffer,
    filename: string,
    content: string,
  ): Promise<void> {
    const form = new FormData();
    form.set(
      'payload_json',
      JSON.stringify({
        content: content.slice(0, 2_000),
        attachments: [{ id: 0, filename }],
      }),
    );
    form.set(
      'files[0]',
      new Blob([new Uint8Array(image)], { type: 'image/png' }),
      filename,
    );
    await this.callForm<unknown>(
      'POST',
      `/webhooks/${applicationId}/${interactionToken}`,
      form,
      AbortSignal.timeout(SEND_TIMEOUT_MS),
      false,
    );
  }

  private async call<T>(
    method: string,
    route: string,
    body: unknown,
    signal: AbortSignal,
    authenticated = true,
  ): Promise<T> {
    let response: Response;

    try {
      response = await this.fetch(`${DISCORD_API_BASE}${route}`, {
        method,
        headers: {
          ...(authenticated
            ? { authorization: `Bot ${this.options.botToken}` }
            : {}),
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted) {
        throw error;
      }
      throw new DiscordApiError(method, 'Discord network request failed');
    }

    return parseDiscordResponse<T>(response, method);
  }

  private async callForm<T>(
    method: string,
    route: string,
    body: FormData,
    signal: AbortSignal,
    authenticated = true,
  ): Promise<T> {
    let response: Response;

    try {
      response = await this.fetch(`${DISCORD_API_BASE}${route}`, {
        method,
        headers: authenticated
          ? { authorization: `Bot ${this.options.botToken}` }
          : {},
        body,
        redirect: 'error',
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted) {
        throw error;
      }
      throw new DiscordApiError(method, 'Discord network request failed');
    }

    return parseDiscordResponse<T>(response, method);
  }
}

async function parseDiscordResponse<T>(
  response: Response,
  method: string,
): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    if (response.ok) {
      return undefined as T;
    }
    throw new DiscordApiError(method, 'Discord returned invalid JSON');
  }

  if (!response.ok) {
    throw new DiscordApiError(
      method,
      isDiscordErrorPayload(payload)
        ? 'Discord API rejected request'
        : `Discord API returned HTTP ${response.status}`,
    );
  }

  return payload as T;
}

function isDiscordErrorPayload(value: unknown): value is DiscordErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value
  );
}
