# Session Manager 任務

來源：[`doc/detailed-design.md`](../detailed-design.md) 第 5.10 節

## 模組目標

維護 `channel -> ChannelSession` 對照表，依 Scheduler 產出的 active channel set 建立、保持或停止單一頻道掛台 session，並避免同一頻道重複建立。

## 最小可執行任務

- [ ] 定義 `SessionManager` 介面：`reconcile(activeChannels)`、`stopAll(reason)`、`getActiveChannels()`。
- [ ] 定義 `ChannelSessionFactory` 介面，讓 Session Manager 不直接依賴具體 Channel Session 建構細節。
- [ ] 實作內部 registry：`Map<string, ChannelSession>`。
- [ ] 實作 `reconcile` 新增行為：activeChannels 中不存在於 registry 的頻道要建立並啟動。
- [ ] 實作 `reconcile` 保持行為：已存在且仍 active 的頻道不可重建。
- [ ] 實作 `reconcile` 移除行為：registry 中不在 activeChannels 的頻道要停止並移除。
- [ ] 實作 start session 失敗隔離：記錄 error，不影響其他頻道建立。
- [ ] 實作 stop session 失敗隔離：記錄 warn，避免整個 reconcile 卡死。
- [ ] 實作 `stopAll(reason)`，停止所有 sessions 並清空 registry。
- [ ] 實作 `getActiveChannels()` 回傳目前 registry 中的頻道清單。
- [ ] 撰寫單元測試：新增 session。
- [ ] 撰寫單元測試：移除 session。
- [ ] 撰寫單元測試：保持既有 session 不重建。
- [ ] 撰寫單元測試：同一頻道不重複建立。
- [ ] 撰寫單元測試：start 失敗不影響其他 channel。
- [ ] 撰寫單元測試：stop 失敗仍能完成 reconcile 或標記待清理。

## 完成定義

- [ ] Session Manager 單元測試全部通過。
- [ ] `reconcile` 可安全重複呼叫。
- [ ] 單一頻道錯誤不會阻止其他頻道處理。
