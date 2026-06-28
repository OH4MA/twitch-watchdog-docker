import {
  redactSensitiveString,
  type LogFields,
  type Logger,
} from '../logging/index.js';

export function safeErrorMessage(error: unknown): string {
  let message = 'Unknown channel session failure';
  try {
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error !== undefined && error !== null) {
      message = String(error);
    }
  } catch {
    message = 'Unserializable channel session failure';
  }
  return redactSensitiveString(message);
}

export function safeLog(
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: LogFields,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Logging must not break session cleanup or timer callbacks.
  }
}
