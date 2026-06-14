export class StorageStateNotFoundError extends Error {
  override readonly name = 'StorageStateNotFoundError';

  public constructor(readonly storageStatePath: string) {
    super(
      `找不到登入狀態檔案：${storageStatePath}。` +
        '請重新匯出 Playwright storageState 並掛載到容器',
    );
  }
}

export class StorageStateUnreadableError extends Error {
  override readonly name = 'StorageStateUnreadableError';

  public constructor(readonly storageStatePath: string) {
    super(
      `無法讀取登入狀態檔案：${storageStatePath}。` +
        '請確認檔案已掛載，且執行服務的使用者具有讀取權限',
    );
  }
}

export class StorageStateParseError extends Error {
  override readonly name = 'StorageStateParseError';

  public constructor(readonly storageStatePath: string) {
    super(
      `登入狀態檔案格式錯誤：${storageStatePath}。` +
        '請重新匯出有效的 Playwright storageState JSON',
    );
  }
}

export class StorageStateFormatError extends Error {
  override readonly name = 'StorageStateFormatError';

  public constructor(
    readonly storageStatePath: string,
    detail: string,
  ) {
    super(
      `登入狀態檔案格式錯誤：${storageStatePath}。${detail}；` +
        '請重新匯出有效的 Playwright storageState JSON',
    );
  }
}
