# Credential Module 任務

來源：[`doc/proposal.md`](../proposal.md) 第 3.4 節、[`doc/detailed-design.md`](../detailed-design.md) 第 5.3 節、第 9 節

## 模組目標

在服務啟動時檢查 Twitch API 設定與 Playwright `storageState` JSON，確保登入狀態檔案存在、可讀且格式合法，同時避免在日誌中洩漏敏感資訊。

## 最小可執行任務

- [ ] 定義 `CredentialValidator` 介面與 `CredentialValidationResult` 型別。
- [ ] 實作檢查 `storage_state_path` 是否存在。
- [ ] 實作檢查 `storage_state_path` 是否可讀。
- [ ] 實作讀取並 parse storage state JSON。
- [ ] 實作 storage state 基本格式檢查：頂層為物件，`cookies` 為陣列或可缺省，`origins` 為陣列或可缺省。
- [ ] 實作 cookies 為空時輸出 warn，但不阻止啟動。
- [ ] 實作 storage state 不存在時的清楚錯誤訊息：「找不到登入狀態檔案，請重新匯出 Playwright storageState 並掛載到容器」。
- [ ] 實作 JSON 格式錯誤時的清楚錯誤訊息：「登入狀態檔案格式錯誤」。
- [ ] 實作 Twitch API client id / access token 已由 Config Module 驗證後的結果整理，不進一步驗 token 有效性。
- [ ] 實作遮罩後的憑證摘要供日誌使用，例如 `hasCookies`、`twitchApiConfigured`，不可包含 cookie value 或 token。
- [ ] 撰寫測試 fixture：合法 storage state、空 cookies storage state、格式錯誤 JSON。
- [ ] 撰寫單元測試：檔案不存在、不可讀、JSON 格式錯誤、合法 JSON、cookies 為空。
- [ ] 撰寫測試確認錯誤與日誌不包含 cookie value 或 token。

## 完成定義

- [ ] Credential Module 單元測試全部通過。
- [ ] 啟動前可明確區分 storage state 不存在、不可讀與格式錯誤。
- [ ] Credential 檢查結果可安全寫入日誌。
