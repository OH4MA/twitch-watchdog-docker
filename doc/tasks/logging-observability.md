# Logging & Observability 任務

來源：[`doc/proposal.md`](../proposal.md) 第 4.3 節、[`doc/detailed-design.md`](../detailed-design.md) 第 5.11 節

## 模組目標

提供可由 Docker logs 追蹤的結構化 JSON line 日誌，支援 log level 過濾並遮罩 cookie、token、Authorization header 與 storage state 等敏感資料。

## 最小可執行任務

- [ ] 定義 logger 介面，至少支援 `debug`、`info`、`warn`、`error`。
- [ ] 實作 JSON line 格式輸出，包含 `level`、`event`、`time` 與事件欄位。
- [ ] 實作 log level 過濾。
- [ ] 實作敏感資訊遮罩工具，處理 cookie value、OAuth token、Twitch access token、Authorization header、storageState 原始內容。
- [ ] 建立必要事件名稱常數或型別：`service_started`、`config_loaded`、`config_error`、`credential_checked`、`twitch_api_auth_failed`、`stream_online`、`stream_offline`、`watch_started`、`watch_stopped`、`reward_claimed`、`reward_claim_failed`、`browser_restarted`、`page_health_failed`、`service_stopped`。
- [ ] 實作 logger 可注入輸出目的地，讓測試可攔截 stdout/stderr。
- [ ] 撰寫單元測試：不同 level 的輸出與過濾。
- [ ] 撰寫單元測試：敏感字串會被遮罩。
- [ ] 撰寫單元測試：必要事件欄位格式正確。
- [ ] 在程式入口點接入 logger，取代臨時 `console.log`。

## 完成定義

- [ ] Logger 單元測試全部通過。
- [ ] 所有日誌為可解析 JSON line。
- [ ] 測試證明 token、cookie value、Authorization header 不會原文出現在日誌中。
