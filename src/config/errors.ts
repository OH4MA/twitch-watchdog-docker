export class ConfigFileNotFoundError extends Error {
  override readonly name = 'ConfigFileNotFoundError';

  constructor(readonly configPath: string) {
    super(`找不到設定檔：${configPath}`);
  }
}

export class ConfigParseError extends Error {
  override readonly name = 'ConfigParseError';

  constructor(message: string) {
    super(`設定檔格式錯誤：${message}`);
  }
}

export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError';

  constructor(readonly field: string, message: string) {
    super(`設定欄位 ${field} ${message}`);
  }
}
