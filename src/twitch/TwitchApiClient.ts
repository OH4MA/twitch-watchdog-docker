import { LOG_EVENTS, type Logger } from '../logging/index.js';
import type {
  ChannelLiveStatus,
  LiveStatusProvider,
} from './LiveStatusProvider.js';
import {
  TwitchApiAuthError,
  TwitchApiRateLimitError,
  TwitchApiTemporaryError,
  type TwitchApiTemporaryErrorReason,
} from './errors.js';

export const TWITCH_HELIX_BASE_URL = 'https://api.twitch.tv/helix/';
export const TWITCH_HELIX_MAX_USER_LOGINS = 100;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RATE_LIMIT_FALLBACK_MS = 5 * 60 * 1_000;
const MAX_RESPONSE_BODY_BYTES = 1_000_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface TwitchApiClientOptions {
  readonly clientId: string;
  readonly accessToken: string;
  readonly checkIntervalSeconds: number;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly now?: () => Date;
}

interface HelixStream {
  readonly id: string;
  readonly userLogin: string;
  readonly title: string;
  readonly startedAt: string;
  readonly viewerCount: number;
}

type UnknownRecord = Record<string, unknown>;

export class TwitchApiClient implements LiveStatusProvider {
  private readonly endpoint: URL;
  private readonly fetchFunction: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: TwitchApiClientOptions) {
    requireNonEmpty(options.clientId, 'clientId');
    requireNonEmpty(options.accessToken, 'accessToken');
    requirePositiveFinite(
      options.checkIntervalSeconds,
      'checkIntervalSeconds',
    );

    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    requirePositiveFinite(requestTimeoutMs, 'requestTimeoutMs');
    if (requestTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new RangeError(
        `requestTimeoutMs must be at most ${MAX_TIMER_DELAY_MS}`,
      );
    }

    const baseUrl = options.baseUrl ?? TWITCH_HELIX_BASE_URL;
    this.endpoint = new URL(
      'streams',
      baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
    );
    this.fetchFunction = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = requestTimeoutMs;
    this.now = options.now ?? (() => new Date());
  }

  async getLiveStatuses(
    channels: readonly string[],
  ): Promise<ChannelLiveStatus[]> {
    if (channels.length === 0) {
      return [];
    }

    const liveStreams = new Map<string, HelixStream>();

    for (
      let offset = 0;
      offset < channels.length;
      offset += TWITCH_HELIX_MAX_USER_LOGINS
    ) {
      const batch = channels.slice(
        offset,
        offset + TWITCH_HELIX_MAX_USER_LOGINS,
      );
      const streams = await this.requestStreams(batch);

      for (const stream of streams) {
        liveStreams.set(normalizeChannel(stream.userLogin), stream);
      }
    }

    const checkedAt = this.now().toISOString();

    return channels.map((channel) => {
      const stream = liveStreams.get(normalizeChannel(channel));
      if (stream === undefined) {
        return {
          channel,
          isLive: false,
          checkedAt,
        };
      }

      return {
        channel,
        isLive: true,
        streamId: stream.id,
        title: stream.title,
        startedAt: stream.startedAt,
        viewerCount: stream.viewerCount,
        checkedAt,
      };
    });
  }

  private async requestStreams(
    channels: readonly string[],
  ): Promise<HelixStream[]> {
    const url = new URL(this.endpoint);
    const searchParams = new URLSearchParams();
    for (const channel of channels) {
      searchParams.append('user_login', channel);
    }
    url.search = searchParams.toString();

    const request = await this.fetchWithTimeout(url);
    const response = request.response;

    try {
      if (response.status === 401 || response.status === 403) {
        const error = new TwitchApiAuthError(response.status);
        this.options.logger.error(LOG_EVENTS.TWITCH_API_AUTH_FAILED, {
          statusCode: response.status,
        });
        throw error;
      }

      if (response.status === 429) {
        const error = this.createRateLimitError(response.headers);
        this.options.logger.warn('twitch_api_rate_limited', {
          statusCode: response.status,
          retryAt: error.retryAt.toISOString(),
          retryAfterMs: error.retryAfterMs,
        });
        throw error;
      }

      if (response.status >= 500) {
        throw this.createTemporaryError('server', response.status);
      }

      if (response.status !== 200) {
        throw this.createTemporaryError('http', response.status);
      }

      try {
        const payload = await readLimitedJson(
          response,
          MAX_RESPONSE_BODY_BYTES,
        );
        return parseHelixStreams(payload);
      } catch (error: unknown) {
        if (request.didTimeOut()) {
          throw this.createTemporaryError('timeout');
        }
        if (isAbortError(error)) {
          throw this.createTemporaryError('aborted');
        }
        throw this.createTemporaryError('invalid-response', response.status);
      }
    } finally {
      request.finish();
    }
  }

  private async fetchWithTimeout(url: URL): Promise<{
    readonly response: Response;
    didTimeOut(): boolean;
    finish(): void;
  }> {
    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.requestTimeoutMs);

    try {
      const response = await this.fetchFunction(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'Client-Id': this.options.clientId,
          Authorization: `Bearer ${this.options.accessToken}`,
        },
        signal: abortController.signal,
      });
      return {
        response,
        didTimeOut: () => timedOut,
        finish: () => {
          clearTimeout(timeout);
        },
      };
    } catch (error: unknown) {
      clearTimeout(timeout);
      const reason: TwitchApiTemporaryErrorReason = timedOut
        ? 'timeout'
        : isAbortError(error)
          ? 'aborted'
          : 'network';
      throw this.createTemporaryError(reason);
    }
  }

  private createRateLimitError(headers: Headers): TwitchApiRateLimitError {
    const now = this.now();
    const resetEpochSeconds = parseResetEpochSeconds(
      headers.get('Ratelimit-Reset'),
    );

    if (resetEpochSeconds !== undefined) {
      const requestedRetryAfterMs = Math.max(
        0,
        resetEpochSeconds * 1_000 - now.getTime(),
      );
      const retryAfterMs = Math.min(
        requestedRetryAfterMs,
        MAX_RATE_LIMIT_FALLBACK_MS,
      );
      const retryAt = new Date(now.getTime() + retryAfterMs);
      return new TwitchApiRateLimitError(
        retryAt,
        retryAfterMs,
      );
    }

    const retryAfterMs = Math.min(
      this.options.checkIntervalSeconds * 2 * 1_000,
      MAX_RATE_LIMIT_FALLBACK_MS,
    );
    return new TwitchApiRateLimitError(
      new Date(now.getTime() + retryAfterMs),
      retryAfterMs,
    );
  }

  private createTemporaryError(
    reason: TwitchApiTemporaryErrorReason,
    statusCode?: number,
  ): TwitchApiTemporaryError {
    const error = new TwitchApiTemporaryError(reason, statusCode);
    const fields: Record<string, unknown> = { reason };
    if (statusCode !== undefined) {
      fields.statusCode = statusCode;
    }
    this.options.logger.warn('twitch_api_temporary_error', fields);
    return error;
  }
}

async function readLimitedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get('Content-Length');
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > maximumBytes
  ) {
    throw new TypeError('Twitch API response is too large');
  }
  if (response.body === null) {
    throw new TypeError('Twitch API response body is missing');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new TypeError('Twitch API response is too large');
    }
    chunks.push(result.value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function parseHelixStreams(payload: unknown): HelixStream[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new TypeError('Invalid Twitch API response');
  }

  const streams = payload.data.map((value) => parseHelixStream(value));
  const userLogins = new Set<string>();

  for (const stream of streams) {
    const userLogin = normalizeChannel(stream.userLogin);
    if (userLogins.has(userLogin)) {
      throw new TypeError('Invalid Twitch API response');
    }
    userLogins.add(userLogin);
  }

  return streams;
}

function parseHelixStream(value: unknown): HelixStream {
  if (!isRecord(value)) {
    throw new TypeError('Invalid Twitch API response');
  }

  const id = requireResponseString(value.id);
  const userLogin = requireResponseString(value.user_login);
  const title = requireResponseString(value.title, true);
  const startedAt = requireResponseTimestamp(value.started_at);
  const viewerCount = requireViewerCount(value.viewer_count);

  return {
    id,
    userLogin,
    title,
    startedAt,
    viewerCount,
  };
}

function requireResponseString(
  value: unknown,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new TypeError('Invalid Twitch API response');
  }
  return value;
}

function requireResponseTimestamp(value: unknown): string {
  const timestamp = requireResponseString(value);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError('Invalid Twitch API response');
  }
  return timestamp;
}

function requireViewerCount(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError('Invalid Twitch API response');
  }
  return value;
}

function parseResetEpochSeconds(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) {
    return undefined;
  }

  const seconds = Number(value);
  const retryAt = new Date(seconds * 1_000);
  return Number.isSafeInteger(seconds) && !Number.isNaN(retryAt.getTime())
    ? seconds
    : undefined;
}

function normalizeChannel(channel: string): string {
  return channel.toLowerCase();
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim() === '') {
    throw new TypeError(`${field} must not be empty`);
  }
}

function requirePositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive number`);
  }
}
