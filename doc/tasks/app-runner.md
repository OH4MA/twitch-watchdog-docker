# App Runner 任務

來源：[`doc/detailed-design.md`](../detailed-design.md) 第 3.2 節、第 5.1 節

## 模組目標

作為程式入口與生命週期管理器，依序初始化 Config、Logger、Credential、Browser、Scheduler，處理啟動失敗與 SIGTERM/SIGINT 優雅關閉。

## 最小可執行任務

- [ ] 定義 `AppRunner` 介面：`start()`、`stop(reason)`。
- [ ] 實作 `AppRunner` 建構參數注入，讓測試可傳入 mock ConfigLoader、CredentialValidator、BrowserManager、WatchdogScheduler、Logger。
- [ ] 在 `start()` 讀取 `CONFIG_PATH`，未設定時使用 `/app/config.yml`。
- [ ] 初始化 logger 並輸出 `config_loaded`、`credential_checked`、`service_started` 等事件。
- [ ] 在啟動流程中依序執行：Config → Logger → Credential → Browser → Scheduler。
- [ ] 若 Config 驗證失敗，輸出 `config_error` 並以非 0 exit code 或明確錯誤結束。
- [ ] 若 Credential 驗證失敗，輸出清楚錯誤並避免啟動 Browser/Scheduler。
- [ ] 若 Browser 啟動失敗，清理已初始化資源。
- [ ] 實作未處理例外與 unhandled rejection 的安全日誌，不輸出敏感資訊。
- [ ] 實作 SIGTERM/SIGINT handler，呼叫 `stop(reason)`。
- [ ] 實作 `stop(reason)` 順序：停止 Scheduler → stopAll Channel Sessions（如由 Session Manager 暴露）→ 關閉 Browser Manager → flush logger。
- [ ] 確保 `stop()` 可重複呼叫且只釋放一次資源。
- [ ] 在 `src/index.ts` 實際建立並啟動 App Runner。
- [ ] 撰寫單元測試：啟動順序正確。
- [ ] 撰寫單元測試：設定失敗時不啟動後續模組。
- [ ] 撰寫單元測試：credential 失敗時不啟動 browser/scheduler。
- [ ] 撰寫單元測試：stop 順序正確。
- [ ] 撰寫單元測試：stop 重複呼叫不重複釋放。

## 完成定義

- [ ] App Runner 單元測試全部通過。
- [ ] 程式可從 `src/index.ts` 啟動完整服務。
- [ ] 啟動失敗路徑有清楚、安全的錯誤訊息。
- [ ] SIGTERM/SIGINT 可觸發優雅關閉。
