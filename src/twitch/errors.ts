export type TwitchApiErrorKind = 'auth' | 'rate-limit' | 'temporary';

export abstract class TwitchApiError extends Error {
  abstract readonly kind: TwitchApiErrorKind;
}

export class TwitchApiAuthError extends TwitchApiError {
  override readonly name = 'TwitchApiAuthError';
  readonly kind = 'auth';

  constructor(readonly statusCode: 401 | 403) {
    super(`Twitch API authentication failed (HTTP ${statusCode})`);
  }
}

export class TwitchApiRateLimitError extends TwitchApiError {
  override readonly name = 'TwitchApiRateLimitError';
  readonly kind = 'rate-limit';

  constructor(
    readonly retryAt: Date,
    readonly retryAfterMs: number,
  ) {
    super('Twitch API rate limit exceeded');
  }
}

export type TwitchApiTemporaryErrorReason =
  | 'aborted'
  | 'http'
  | 'invalid-response'
  | 'network'
  | 'server'
  | 'timeout';

export class TwitchApiTemporaryError extends TwitchApiError {
  override readonly name = 'TwitchApiTemporaryError';
  readonly kind = 'temporary';

  constructor(
    readonly reason: TwitchApiTemporaryErrorReason,
    readonly statusCode: number | undefined,
  ) {
    super('Twitch API request failed temporarily');
  }
}
