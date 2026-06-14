# 測試與 Mock Twitch Pages 任務

來源：[`doc/detailed-design.md`](../detailed-design.md) 第 10 節、第 15 節

## 模組目標

建立可支援單元測試、模組整合測試、Playwright mock page 測試與 Docker smoke test 的測試基礎，讓核心行為可在不連線真實 Twitch 頁面的情況下驗證。

## 最小可執行任務

- [ ] 選定並設定單元測試框架（Vitest 或 Jest）。
- [ ] 設定 TypeScript 測試執行環境。
- [ ] 建立共用測試 helper：時間固定、mock logger、mock config。
- [ ] 建立 Config fixture：合法設定、缺少欄位、錯誤型別。
- [ ] 建立 Credential fixture：合法 storage state、空 cookies、格式錯誤 JSON。
- [ ] 建立 Twitch API mock HTTP client 或 mock server。
- [ ] 建立 Playwright test 設定，供 mock pages 測試使用。
- [ ] 建立 `test/mock-pages/live.html`，模擬直播頁與播放器容器。
- [ ] 建立 `test/mock-pages/offline.html`，模擬離線頁。
- [ ] 建立 `test/mock-pages/reward-available.html`，包含可點擊忠誠點數按鈕。
- [ ] 建立 `test/mock-pages/reward-disabled.html`，包含 disabled 或不可見按鈕。
- [ ] 建立 `test/mock-pages/login-required.html`，模擬登入失效。
- [ ] 建立 `test/mock-pages/error.html`，模擬播放器錯誤或頁面錯誤。
- [ ] 撰寫 Playwright 測試：reward button 存在時會被點擊。
- [ ] 撰寫 Playwright 測試：reward button 不存在時不視為錯誤。
- [ ] 撰寫 Playwright 測試：login-required 可被 Channel Session 健康檢查偵測。
- [ ] 撰寫 Playwright 測試：error page 可被 Channel Session 健康檢查偵測。
- [ ] 建立驗收標準對應測試清單，連結到各模組測試。
- [ ] 在 CI 或本機 scripts 中加入 `npm test` 與 Playwright 測試命令。

## 完成定義

- [ ] 單元測試、整合測試與 Playwright mock page 測試可分別執行。
- [ ] mock pages 覆蓋詳細設計列出的六種頁面狀態。
- [ ] 測試可驗證主要驗收標準，不依賴真實 Twitch 網站狀態。
