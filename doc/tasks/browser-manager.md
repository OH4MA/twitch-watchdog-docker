# Browser Manager 任務

來源：[`doc/proposal.md`](../proposal.md) 第 3.2 節、第 4.2 節、[`doc/detailed-design.md`](../detailed-design.md) 第 5.7 節

## 模組目標

管理 Playwright Chromium browser 與 browser context，使用 `storageState` 建立登入狀態，為 Channel Session 建立/關閉 page，並處理 page 或 browser crash 復原。

## 最小可執行任務

- [ ] 定義 `BrowserManager` 介面：`start()`、`stop()`、`createPage(channel)`、`closePage(channel)`、`restart()`。
- [ ] 實作 Playwright Chromium 啟動，`headless` 由設定控制。
- [ ] 建立 browser context 時載入 `storageState: config.storageStatePath`。
- [ ] 設定預設 viewport：`1280x720`。
- [ ] 實作 `createPage(channel)`，建立 page 並記錄 channel 與 page 的對應關係。
- [ ] 實作 `closePage(channel)`，關閉並移除對應 page。
- [ ] 實作 `stop()`，關閉所有 pages、context 與 browser。
- [ ] 實作單一 page crash 監聽：記錄錯誤並讓對應 session 在下一輪可重建。
- [ ] 實作 browser crash 監聽：標記所有 sessions 需要重建並嘗試 `restart()`。
- [ ] 實作 `restart()` 退避或避免快速無限重啟的基本防護。
- [ ] 實作 `browser_restarted` 與相關錯誤日誌。
- [ ] 撰寫 mock Browser/Page 單元測試：start 建立 browser/context。
- [ ] 撰寫 mock Browser/Page 單元測試：createPage / closePage。
- [ ] 撰寫 mock Browser/Page 單元測試：stop 釋放資源。
- [ ] 撰寫 mock Browser/Page 單元測試：page crash 與 browser crash 行為。
- [ ] 規劃或建立 Playwright integration fixture，用於後續 mock Twitch 頁面測試。

## 完成定義

- [ ] Browser Manager 測試全部通過。
- [ ] context 建立參數包含 storage state 與 viewport。
- [ ] stop/restart 可重複呼叫且不造成未處理例外。
- [ ] crash 路徑有安全日誌且不輸出 storageState 內容。
