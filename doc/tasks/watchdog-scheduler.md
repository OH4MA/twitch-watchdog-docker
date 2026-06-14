# Watchdog Scheduler 任務

來源：[`doc/proposal.md`](../proposal.md) 第 3.1 節、第 3.2 節、[`doc/detailed-design.md`](../detailed-design.md) 第 5.5 節

## 模組目標

定期查詢 Twitch 直播狀態，偵測頻道 online/offline 狀態變更，透過 Stream Selection 決定 active set，並呼叫 Session Manager 建立或停止掛台 sessions。

## 最小可執行任務

- [ ] 定義 `WatchdogScheduler` 介面：`start()`、`stop()`、`runOnce()`。
- [ ] 實作 scheduler 建構參數注入：config、LiveStatusProvider、StreamSelector、SessionManager、Logger。
- [ ] 實作 `runOnce()` 查詢所有 configured channels 的 live statuses。
- [ ] 實作上一輪與本輪狀態比較，產生 `stream_online` / `stream_offline` 日誌。
- [ ] 呼叫 Stream Selector 取得 active channels。
- [ ] 呼叫 Session Manager `reconcile(activeChannels)`。
- [ ] 實作 tick 不重入保護：上一輪尚未完成時略過下一次 tick 並記錄 `scheduler_tick_skipped`。
- [ ] 實作 `start()` 依 `check_interval_seconds` 建立定時輪詢。
- [ ] 實作 `stop()` 停止定時器並等待正在執行的 tick 完成或安全結束。
- [ ] 實作 Twitch API 暫時失敗時不停止既有 sessions。
- [ ] 實作 401/403 或 429 錯誤時的 scheduler 行為：記錄錯誤/限流，本輪不 reconcile 成空集合。
- [ ] 撰寫單元測試：live → start session。
- [ ] 撰寫單元測試：offline → stop session。
- [ ] 撰寫單元測試：live set 未變時不重建 session。
- [ ] 撰寫單元測試：高優先序頻道上線且超出併發上限時 active set 更新。
- [ ] 撰寫單元測試：API 失敗時不停止既有 sessions。
- [ ] 撰寫單元測試：tick 不重入。

## 完成定義

- [ ] Watchdog Scheduler 單元測試全部通過。
- [ ] `runOnce()` 可被測試與手動觸發。
- [ ] API 暫時失敗不會誤關閉正在掛台的頻道。
- [ ] Scheduler 可被 App Runner 優雅啟動與停止。
