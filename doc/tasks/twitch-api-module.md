# Twitch API Module 任務

來源：[`doc/proposal.md`](../proposal.md) 第 3.1 節、[`doc/detailed-design.md`](../detailed-design.md) 第 5.4 節

## 模組目標

使用 Twitch Helix API 查詢設定頻道是否正在直播，將 API 回應轉換為內部 `ChannelLiveStatus`，並處理授權錯誤、限流與暫時性錯誤。

## 最小可執行任務

- [ ] 定義 `ChannelLiveStatus` 型別與 `LiveStatusProvider` 介面。
- [ ] 建立 Twitch API HTTP client 包裝，集中設定 base URL 與 headers。
- [ ] 實作 `GET /helix/streams?user_login=...` 多頻道查詢。
- [ ] 實作 request headers：`Client-Id` 與 `Authorization: Bearer <access_token>`。
- [ ] 實作 200 回應轉換：`data` 中存在的頻道為 live，不存在的設定頻道為 offline。
- [ ] 保留原設定頻道名稱順序或確保呼叫端可依設定順序排序。
- [ ] 將 Twitch 回應欄位轉為 `streamId`、`title`、`startedAt`、`viewerCount`、`checkedAt`。
- [ ] 實作 401/403 處理：記錄 `twitch_api_auth_failed`，本輪狀態更新失敗，錯誤訊息不含 token。
- [ ] 實作 429 處理：讀取 reset header；無法解析時使用 `check_interval_seconds * 2`，上限 5 分鐘。
- [ ] 實作 5xx 與網路錯誤處理：拋出暫時錯誤，讓 Scheduler 保留既有 sessions。
- [ ] 實作 token / Authorization header 遮罩測試。
- [ ] 撰寫 mock HTTP client 或 mock server 測試：部分 live、全部 offline、401、403、429、5xx、timeout。

## 完成定義

- [ ] Twitch API Module 測試全部通過。
- [ ] 可一次查詢多個頻道並回傳每個設定頻道的狀態。
- [ ] API 錯誤分類可讓 Scheduler 區分授權、限流與暫時錯誤。
- [ ] 任一錯誤路徑都不輸出 access token。
