import { readFile } from 'node:fs/promises';

import type { AppConfig } from '../config/index.js';
import { LOG_EVENTS } from '../logging/index.js';
import {
  StorageStateFormatError,
  StorageStateNotFoundError,
  StorageStateParseError,
  StorageStateUnreadableError,
} from './errors.js';

export interface CredentialValidationResult {
  readonly storageStatePath: string;
  readonly hasCookies: boolean;
  readonly twitchApiConfigured: boolean;
}

export interface CredentialValidator {
  validate(config: AppConfig): Promise<CredentialValidationResult>;
}

export interface CredentialLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export type CredentialReadFile = (
  path: string,
  encoding: BufferEncoding,
) => Promise<string>;

export interface FileCredentialValidatorOptions {
  readonly logger?: CredentialLogger;
  readonly readFile?: CredentialReadFile;
}

type StorageState = {
  readonly cookies?: readonly unknown[];
  readonly origins?: readonly unknown[];
};

const NOOP_LOGGER: CredentialLogger = {
  info: () => undefined,
  warn: () => undefined,
};

const DEFAULT_READ_FILE: CredentialReadFile = async (path, encoding) =>
  readFile(path, encoding);

export class FileCredentialValidator implements CredentialValidator {
  private readonly logger: CredentialLogger;
  private readonly readFile: CredentialReadFile;

  public constructor(options: FileCredentialValidatorOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.readFile = options.readFile ?? DEFAULT_READ_FILE;
  }

  public async validate(
    config: AppConfig,
  ): Promise<CredentialValidationResult> {
    const source = await this.readStorageState(config.storageStatePath);
    const storageState = parseStorageState(source, config.storageStatePath);
    const hasCookies = (storageState.cookies?.length ?? 0) > 0;
    const result = Object.freeze({
      storageStatePath: config.storageStatePath,
      hasCookies,
      twitchApiConfigured:
        config.twitchApi.clientId.trim().length > 0 &&
        (
          config.twitchApi.accessToken.trim().length > 0 ||
          config.twitchApi.clientSecret.trim().length > 0
        ),
    });

    if (!hasCookies) {
      this.logger.warn('credential_storage_state_empty_cookies', {
        storageStatePath: result.storageStatePath,
        hasCookies: result.hasCookies,
        twitchApiConfigured: result.twitchApiConfigured,
      });
    }

    this.logger.info(LOG_EVENTS.CREDENTIAL_CHECKED, result);

    return result;
  }

  private async readStorageState(storageStatePath: string): Promise<string> {
    try {
      return await this.readFile(storageStatePath, 'utf8');
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new StorageStateNotFoundError(storageStatePath);
      }

      throw new StorageStateUnreadableError(storageStatePath);
    }
  }
}

function parseStorageState(
  source: string,
  storageStatePath: string,
): StorageState {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch {
    throw new StorageStateParseError(storageStatePath);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new StorageStateFormatError(
      storageStatePath,
      'JSON 頂層必須是物件',
    );
  }

  const storageState = parsed as Record<string, unknown>;

  if (
    storageState.cookies !== undefined &&
    !Array.isArray(storageState.cookies)
  ) {
    throw new StorageStateFormatError(
      storageStatePath,
      'cookies 若存在必須是陣列',
    );
  }

  if (
    storageState.origins !== undefined &&
    !Array.isArray(storageState.origins)
  ) {
    throw new StorageStateFormatError(
      storageStatePath,
      'origins 若存在必須是陣列',
    );
  }

  return storageState as StorageState;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
