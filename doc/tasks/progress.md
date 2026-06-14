# Twitch Watchdog 實作總體進度

來源：[`doc/proposal.md`](../proposal.md)、[`doc/detailed-design.md`](../detailed-design.md)

## 模組完成情況

- [x] [專案骨架與開發工具](project-scaffold.md)
- [x] [Config Module](config-module.md)
- [x] [Logging & Observability](logging-observability.md)
- [x] [Credential Module](credential-module.md)
- [x] [Twitch API Module](twitch-api-module.md)
- [x] [Stream Selection Module](stream-selection-module.md)
- [x] [Session Manager](session-manager.md)
- [x] [Watchdog Scheduler](watchdog-scheduler.md)
- [x] [App Runner](app-runner.md)
- [x] [Browser Manager](browser-manager.md)
- [x] [Channel Session](channel-session.md)
- [x] [Reward Claimer](reward-claimer.md)
- [x] [測試與 Mock Twitch Pages](testing-mock-pages.md)
- [x] [Docker 與部署文件](docker-and-docs.md)
- [x] 全部驗收標準通過

## 建議實作順序

- [x] 1. 完成 [專案骨架與開發工具](project-scaffold.md)。
- [x] 2. 完成 [Logging & Observability](logging-observability.md)，讓後續模組可共用安全日誌。
- [x] 3. 完成 [Config Module](config-module.md)。
- [x] 4. 完成 [Credential Module](credential-module.md)。
- [x] 5. 完成 [Twitch API Module](twitch-api-module.md)。
- [x] 6. 完成 [Stream Selection Module](stream-selection-module.md)。
- [x] 7. 完成 [Session Manager](session-manager.md)。
- [x] 8. 完成 [Watchdog Scheduler](watchdog-scheduler.md)。
- [x] 9. 完成 [Browser Manager](browser-manager.md)。
- [x] 10. 完成 [Reward Claimer](reward-claimer.md)。
- [x] 11. 完成 [Channel Session](channel-session.md)，整合 Browser Manager 與 Reward Claimer。
- [x] 12. 完成 [測試與 Mock Twitch Pages](testing-mock-pages.md)。
- [x] 13. 完成 [Docker 與部署文件](docker-and-docs.md)。
- [x] 14. 執行整體驗收測試與 Docker smoke test。

## 實作決策紀錄

- 2026-06-14：採用 Node.js ESM、TypeScript strict、Vitest 與 Playwright Test。
- 2026-06-14：鎖定 `playwright` 與 `@playwright/test` `1.60.0`；Docker base image 必須使用相同版本。
- 2026-06-14：鎖定 `yaml` `2.9.0`，不維護自製 YAML parser。
- 2026-06-14：套件管理使用 npm，lockfile 為 `package-lock.json`。
- 2026-06-14：外部時間、HTTP、Playwright 與輸出均以小型介面或建構參數注入，避免測試依賴真實 Twitch。
- 2026-06-14：初始骨架已由主 Agent 執行 `npm run lint`、`npm run build`、`npm test` 驗證通過。
- 2026-06-14：Browser Manager 透過 invalidation observer 回報 page/browser 失效；Session Manager 將提供明確 invalidate 入口以移除失效 registry。
- 2026-06-14：Playwright E2E 在受限 macOS sandbox 內無法建立 Chromium Mach port；經核准於 sandbox 外執行 Reward Claimer mock page 測試，6/6 通過。
- 2026-06-14：Wave 4 整合後由主 Agent 執行 `npm run lint`、`npm run build`、`npm test`（187 項）及 sandbox 外 `npm run test:e2e`（10 項），全部通過。
- 2026-06-14：App Runner 與跨模組測試整合後，主 Agent 執行 `npm run lint`、`npm run build`、`npm test`（201 項）及 `npm run test:integration`（4 項），全部通過。
- 2026-06-14：獨立安全審查後修補 YAML 循環 alias、Node timer overflow、Helix redirect/body timeout/size、遠期 rate-limit reset、popup、導向來源與 smoke cleanup 邊界。
- 2026-06-14：Chromium sandbox 採 Playwright `v1.60.0` 官方 `seccomp_profile.json`；Compose 同時使用非 root、唯讀 root filesystem 與 `no-new-privileges`。
- 2026-06-14：最終由主 Agent 執行 `npm run lint`、`npm run build`、`npm test`（213 項）、`npm run test:integration`（4 項）、sandbox 外 `npm run test:e2e`（10 項）、`npm audit --omit=dev`（0 漏洞）與完整 Docker smoke，全部通過。

## 驗收標準追蹤

- [x] 使用者可使用 Dockerfile 成功建置映像檔。
- [x] 使用者可使用 docker-compose 啟動服務。
- [x] 使用者可透過設定檔指定至少兩個 Twitch 頻道。
- [x] 系統可讀取掛載的 Twitch 登入狀態資料。
- [x] 當指定頻道開台時，系統會自動開啟該頻道頁面掛台。
- [x] 當忠誠點數按鈕出現時，系統會自動點擊領取。
- [x] 領取成功、失敗與頻道狀態變化會被記錄於日誌。
- [x] 容器重新啟動後，系統可再次讀取既有設定與登入狀態並恢復運作。

## 初版範圍限制追蹤

- [x] 不實作自動輸入 Twitch 帳號密碼登入。
- [x] 不實作多帳號管理。
- [x] 不實作 Web UI。
- [x] 不實作 Discord、Telegram、Email 通知。
- [x] 不實作反偵測、繞過驗證、規避平台限制、批量帳號或大量觀看數用途。
