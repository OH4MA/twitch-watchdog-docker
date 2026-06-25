export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_EVENTS = {
  SERVICE_STARTED: 'service_started',
  CONFIG_LOADED: 'config_loaded',
  CONFIG_ERROR: 'config_error',
  CREDENTIAL_CHECKED: 'credential_checked',
  TWITCH_API_AUTH_FAILED: 'twitch_api_auth_failed',
  STREAM_ONLINE: 'stream_online',
  STREAM_OFFLINE: 'stream_offline',
  WATCH_STARTED: 'watch_started',
  WATCH_STOPPED: 'watch_stopped',
  REWARD_CLAIMED: 'reward_claimed',
  REWARD_CLAIM_FAILED: 'reward_claim_failed',
  REWARD_CLAIM_FAILURE_THRESHOLD: 'reward_claim_failure_threshold',
  REWARD_CLAIM_FAILURE_RECOVERY_REFRESH:
    'reward_claim_failure_recovery_refresh',
  CONTAINER_RESTART_REQUESTED: 'container_restart_requested',
  BROWSER_RESTARTED: 'browser_restarted',
  PAGE_HEALTH_FAILED: 'page_health_failed',
  SERVICE_STOPPED: 'service_stopped',
} as const;

export type LogEventName = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  flush(): Promise<void>;
}

export interface LoggerOutput {
  write(line: string): void;
  flush?(): Promise<void> | void;
}

export interface JsonLineLoggerOptions {
  level?: LogLevel;
  output?: LoggerOutput;
  now?: () => Date;
}

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const REDACTED_VALUE = '[REDACTED]';
export const CIRCULAR_VALUE = '[Circular]';

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const RESERVED_FIELDS = new Set(['level', 'event', 'time']);
const OMITTED_VALUE = '[Undefined]';
const ACCESSOR_VALUE = '[Accessor]';
const UNSERIALIZABLE_VALUE = '[Unserializable]';

const defaultOutput: LoggerOutput = {
  write(line: string): void {
    process.stdout.write(line);
  },
  async flush(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write('', (error) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  },
};

const BEARER_TOKEN_PATTERN = /\bBearer\s+[^\s"',;]+/giu;
const BROAD_ASSIGNMENT_PATTERN =
  /(["']?\b(?:cookies?|authorization|storage[\s_-]?state)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/giu;
const TOKEN_ASSIGNMENT_PATTERN =
  /(["']?\b(?:token|access[\s_-]?token|oauth(?:[\s_-]?token)?)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu;

export class JsonLineLogger implements Logger {
  private readonly minimumPriority: number;
  private readonly output: LoggerOutput;
  private readonly now: () => Date;

  public constructor(options: JsonLineLoggerOptions = {}) {
    const level = options.level ?? 'info';
    this.minimumPriority = LEVEL_PRIORITY[level];
    this.output = options.output ?? defaultOutput;
    this.now = options.now ?? (() => new Date());
  }

  public debug(event: string, fields: LogFields = {}): void {
    this.log('debug', event, fields);
  }

  public info(event: string, fields: LogFields = {}): void {
    this.log('info', event, fields);
  }

  public warn(event: string, fields: LogFields = {}): void {
    this.log('warn', event, fields);
  }

  public error(event: string, fields: LogFields = {}): void {
    this.log('error', event, fields);
  }

  public async flush(): Promise<void> {
    await this.output.flush?.();
  }

  private log(level: LogLevel, event: string, fields: LogFields): void {
    if (LEVEL_PRIORITY[level] < this.minimumPriority) {
      return;
    }

    const record = {
      level,
      event,
      time: this.now().toISOString(),
      ...redactLogFields(fields),
    };

    this.output.write(`${JSON.stringify(record)}\n`);
  }
}

export function createLogger(options: JsonLineLoggerOptions = {}): Logger {
  return new JsonLineLogger(options);
}

export function redactSensitiveString(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED_VALUE}`)
    .replace(BROAD_ASSIGNMENT_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(TOKEN_ASSIGNMENT_PATTERN, `$1${REDACTED_VALUE}`);
}

export function redactSensitiveData(value: unknown): JsonValue {
  return sanitizeValue(value, new WeakSet<object>());
}

function redactLogFields(fields: LogFields): Record<string, JsonValue> {
  const sanitized = redactSensitiveData(fields);
  if (sanitized === null || Array.isArray(sanitized) || typeof sanitized !== 'object') {
    return { fields: sanitized };
  }

  return Object.fromEntries(
    Object.entries(sanitized).filter(([key]) => !RESERVED_FIELDS.has(key)),
  );
}

function sanitizeValue(value: unknown, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? redactSensitiveString(value) : value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'undefined') {
    return OMITTED_VALUE;
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    return redactSensitiveString(String(value));
  }

  if (ancestors.has(value)) {
    return CIRCULAR_VALUE;
  }

  ancestors.add(value);

  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString();
    }

    if (value instanceof Error) {
      return sanitizeError(value, ancestors);
    }

    if (Array.isArray(value)) {
      return Array.from(value, (item) => sanitizeValue(item, ancestors));
    }

    if (value instanceof Map) {
      return sanitizeMap(value, ancestors);
    }

    if (value instanceof Set) {
      return Array.from(value, (item) => sanitizeValue(item, ancestors));
    }

    return sanitizeObject(value, ancestors);
  } catch {
    return UNSERIALIZABLE_VALUE;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeError(error: Error, ancestors: WeakSet<object>): JsonValue {
  const entries: Array<[string, JsonValue]> = [
    ['name', redactSensitiveString(error.name)],
    ['message', redactSensitiveString(error.message)],
  ];

  if (error.stack !== undefined) {
    entries.push(['stack', redactSensitiveString(error.stack)]);
  }

  const descriptors = Object.getOwnPropertyDescriptors(error);
  const causeDescriptor = descriptors.cause;
  if (causeDescriptor !== undefined) {
    entries.push([
      'cause',
      'value' in causeDescriptor
        ? sanitizeValue(causeDescriptor.value, ancestors)
        : ACCESSOR_VALUE,
    ]);
  }

  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !descriptor.enumerable ||
      key === 'name' ||
      key === 'message' ||
      key === 'stack' ||
      key === 'cause'
    ) {
      continue;
    }

    entries.push([
      key,
      isSensitiveKey(key)
        ? REDACTED_VALUE
        : 'value' in descriptor
          ? sanitizeValue(descriptor.value, ancestors)
          : ACCESSOR_VALUE,
    ]);
  }

  return Object.fromEntries(entries);
}

function sanitizeMap(
  value: ReadonlyMap<unknown, unknown>,
  ancestors: WeakSet<object>,
): JsonValue {
  const entries: Array<[string, JsonValue]> = [];

  for (const [key, item] of value) {
    const stringKey = String(key);
    entries.push([
      stringKey,
      isSensitiveKey(stringKey)
        ? REDACTED_VALUE
        : sanitizeValue(item, ancestors),
    ]);
  }

  return Object.fromEntries(entries);
}

function sanitizeObject(
  value: object,
  ancestors: WeakSet<object>,
): JsonValue {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<[string, JsonValue]> = [];

  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) {
      continue;
    }

    entries.push([
      key,
      isSensitiveKey(key)
        ? REDACTED_VALUE
        : 'value' in descriptor
          ? sanitizeValue(descriptor.value, ancestors)
          : ACCESSOR_VALUE,
    ]);
  }

  return Object.fromEntries(entries);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '');

  return (
    normalized.includes('cookie') ||
    normalized.includes('token') ||
    normalized.includes('oauth') ||
    normalized.includes('authorization') ||
    normalized.includes('storagestate')
  );
}
