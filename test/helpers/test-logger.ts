import {
  JsonLineLogger,
  type JsonValue,
  type Logger,
} from '../../src/logging/index.js';

export const DEFAULT_TEST_TIME = '2026-06-14T12:00:00.000Z';

export interface FixedClock {
  readonly date: () => Date;
  readonly milliseconds: () => number;
}

export interface RecordingLogger {
  readonly logger: Logger;
  readonly lines: readonly string[];
  records(): readonly Readonly<Record<string, JsonValue>>[];
  serialized(): string;
}

export function createFixedClock(
  isoTime = DEFAULT_TEST_TIME,
): FixedClock {
  const timestamp = new Date(isoTime).getTime();

  if (Number.isNaN(timestamp)) {
    throw new TypeError(`無效的測試時間：${isoTime}`);
  }

  return {
    date: () => new Date(timestamp),
    milliseconds: () => timestamp,
  };
}

export function createRecordingLogger(
  clock: FixedClock = createFixedClock(),
): RecordingLogger {
  const lines: string[] = [];
  const logger = new JsonLineLogger({
    level: 'debug',
    now: clock.date,
    output: {
      write(line): void {
        lines.push(line);
      },
    },
  });

  return {
    logger,
    lines,
    records(): readonly Readonly<Record<string, JsonValue>>[] {
      return lines.map((line) => {
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new TypeError('測試 logger 輸出不是 JSON object');
        }
        return parsed as Readonly<Record<string, JsonValue>>;
      });
    },
    serialized(): string {
      return lines.join('');
    },
  };
}
