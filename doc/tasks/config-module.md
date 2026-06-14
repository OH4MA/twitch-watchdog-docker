# Config Module 任務

來源：[`doc/detailed-design.md`](../detailed-design.md) 第 4 節、第 5.2 節

## 模組目標

讀取 YAML 設定檔，合併預設值與環境變數覆寫，驗證型別與範圍後回傳不可變的 `AppConfig`。

## 最小可執行任務

- [ ] 定義 `AppConfig` 型別，包含 channels、輪詢間隔、併發數、headless、storage state 路徑、log level、Twitch API 與 browser 設定。
- [ ] 建立 `ConfigLoader` 介面與 `ConfigLoader.ts` 實作骨架。
- [ ] 加入 YAML 讀取能力，支援由 `CONFIG_PATH` 指定設定檔路徑。
- [ ] 實作預設值套用：`check_interval_seconds=60`、`max_concurrent_streams=3`、`headless=true`、`storage_state_path=/data/browser-state/storage-state.json`、`log_level=info`、browser 子設定預設值。
- [ ] 實作環境變數覆寫：`TWITCH_CLIENT_ID`、`TWITCH_ACCESS_TOKEN`、`LOG_LEVEL`、`HEADLESS`。
- [ ] 實作 `channels` 驗證：必填、非空陣列、每個名稱符合 Twitch login name 常見格式（英數字與底線，1 到 25 字元）。
- [ ] 實作 `check_interval_seconds >= 30` 驗證。
- [ ] 實作 `max_concurrent_streams >= 1` 驗證，且大於頻道數時降為頻道數並留下 debug 日誌事件。
- [ ] 實作 `log_level` 允許值驗證：`debug`、`info`、`warn`、`error`。
- [ ] 實作 Twitch API client id 與 access token 不可為空驗證，但錯誤訊息不可包含 token 原文。
- [ ] 定義並使用 `ConfigFileNotFoundError`、`ConfigParseError`、`ConfigValidationError`。
- [ ] 寫入合法設定 fixture。
- [ ] 撰寫單元測試：合法設定、缺少 channels、channels 格式錯誤、缺少 token、型別錯誤、環境變數覆寫、預設值套用。
- [ ] 撰寫測試確認驗證錯誤不輸出 Twitch access token。

## 完成定義

- [ ] Config Module 單元測試全部通過。
- [ ] 可從 YAML + env 產出完整 `AppConfig`。
- [ ] 錯誤訊息足以指出欄位，但不洩漏敏感資料。
