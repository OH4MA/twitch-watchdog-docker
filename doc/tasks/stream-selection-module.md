# Stream Selection Module 任務

來源：[`doc/proposal.md`](../proposal.md) 第 3.2 節、[`doc/detailed-design.md`](../detailed-design.md) 第 5.6 節

## 模組目標

根據設定檔中的頻道順序、Twitch API 回傳的直播狀態與 `max_concurrent_streams`，決定本輪應該掛台的 active channel set。

## 最小可執行任務

- [ ] 定義 `StreamSelector` 介面。
- [ ] 實作 `selectActiveChannels(input)` 純函式。
- [ ] 依 `configuredChannels` 順序排序，而不是依 API 回傳順序排序。
- [ ] 過濾 `isLive=true` 的頻道。
- [ ] 取前 `maxConcurrentStreams` 個 live 頻道作為 active set。
- [ ] 忽略不在 `configuredChannels` 中的 live status。
- [ ] 對缺少 live status 的 configured channel 採 offline 處理或明確測試行為。
- [ ] 撰寫單元測試：無人開台。
- [ ] 撰寫單元測試：live 數量少於上限。
- [ ] 撰寫單元測試：live 數量等於上限。
- [ ] 撰寫單元測試：live 數量超過上限時依設定順序截斷。
- [ ] 撰寫單元測試：API 回傳順序不同於設定順序。
- [ ] 撰寫單元測試：API 回傳包含未設定頻道。

## 完成定義

- [ ] Stream Selection 單元測試全部通過。
- [ ] 輸出 active set 可直接交給 Session Manager reconcile。
- [ ] 優先序行為簡單、可預測且無副作用。
