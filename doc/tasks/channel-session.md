# Channel Session 任務

來源：[`doc/proposal.md`](../proposal.md) 第 3.2 節、第 4.2 節、[`doc/detailed-design.md`](../detailed-design.md) 第 5.8 節

## 模組目標

管理單一 Twitch 頻道頁面的生命週期：開啟頻道 URL、維持觀看頁面健康、週期性呼叫 Reward Claimer，並在停止時釋放 page 資源。

## 最小可執行任務

- [ ] 定義 `ChannelSessionState` 型別：`starting`、`watching`、`recovering`、`stopping`、`stopped`、`failed`。
- [ ] 定義 `ChannelSession` 介面：`start()`、`stop(reason)`、`checkHealth()`、`tickRewardClaim()`。
- [ ] 實作 `start()`：透過 Browser Manager 建立 page，導覽到 `https://www.twitch.tv/<channel>`。
- [ ] 設定 page 導覽逾時使用 `browser.navigation_timeout_ms`。
- [ ] 實作 `stop(reason)`：停止內部計時器或工作、關閉 page、記錄 `watch_stopped`。
- [ ] 實作健康檢查：確認 URL 仍在目標 channel。
- [ ] 實作健康檢查：偵測明顯登入提示或未登入狀態。
- [ ] 實作健康檢查：偵測播放器容器或直播內容區域。
- [ ] 實作健康檢查：偵測錯誤頁、網路錯誤或 page crash 狀態。
- [ ] 健康檢查第一次失敗時嘗試 `page.reload()` 並進入 `recovering`。
- [ ] 連續健康檢查失敗超過設定次數後關閉 page，讓 Scheduler 下一輪重建。
- [ ] 實作 `tickRewardClaim()` 呼叫 Reward Claimer，找不到按鈕不影響 session。
- [ ] 實作 reward 檢查週期，使用 `browser.reward_check_interval_seconds`。
- [ ] 實作 page 健康檢查週期，使用 `browser.page_health_check_interval_seconds`。
- [ ] 撰寫 mock page 單元測試：start 導覽到正確 URL。
- [ ] 撰寫 mock page 單元測試：stop 釋放資源。
- [ ] 撰寫 mock page 單元測試：健康檢查成功。
- [ ] 撰寫 mock page 單元測試：健康檢查失敗後 reload。
- [ ] 撰寫 mock page 單元測試：連續失敗後標記重建或 failed。
- [ ] 撰寫 mock Twitch page 測試：正常直播頁、未登入頁、錯誤頁、reload 後恢復。

## 完成定義

- [ ] Channel Session 測試全部通過。
- [ ] 單一 session 可獨立 start/stop 且釋放 page。
- [ ] 健康檢查失敗會嘗試恢復，不會洩漏 cookie 或 token。
- [ ] Reward Claimer 失敗不會直接停止掛台 session。
