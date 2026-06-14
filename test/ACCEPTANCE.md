# 驗收測試矩陣

所有自動化測試僅使用假憑證、本機 fixture、mock HTTP 或 mock page，不連線真實 Twitch。

| 需求／風險 | 測試檔 | 驗證命令 |
|---|---|---|
| 設定至少兩個頻道並完成啟動前置驗證 | `test/integration/startup-prerequisites.test.ts` | `npm run test:integration` |
| 讀取掛載概念相同的外部 `storageState`，缺檔時阻止啟動 | `test/integration/startup-prerequisites.test.ts`、`test/unit/credential.test.ts` | `npm run test:integration`、`npm run test:unit` |
| Helix 部分 live 會依優先序與上限建立 sessions | `test/integration/watchdog-flow.test.ts` | `npm run test:integration` |
| 下一輪高優先序頻道上線會替換低優先序 session | `test/integration/watchdog-flow.test.ts` | `npm run test:integration` |
| Twitch API 暫時失敗保留既有 sessions | `test/integration/watchdog-flow.test.ts` | `npm run test:integration` |
| Browser page 失效會 invalidate session，下一輪 scheduler 重建 | `test/integration/browser-invalidation.test.ts` | `npm run test:integration` |
| Reward 按鈕存在、fallback、disabled、不存在、點擊失敗與冷卻 | `test/e2e/reward-claimer.spec.ts` | `npm run test:e2e` |
| live、offline、login-required、error mock pages 健康判斷 | `test/e2e/channel-session.spec.ts` | `npm run test:e2e` |
| 頻道與領點狀態日誌、層級與敏感資料遮罩 | `test/unit/logging.test.ts`、上述整合測試 | `npm test` |
| Config、Credential、API、Selector、Browser、Session、Scheduler 模組契約 | `test/unit/**/*.test.ts` | `npm run test:unit` |
| TypeScript 建置與靜態檢查 | 全部產品程式與測試 | `npm run build`、`npm run lint` |
| YAML 循環 alias、timer overflow、Helix redirect/body 限制與 rate-limit 上限 | `test/unit/config.test.ts`、`test/unit/twitch-api.test.ts` | `npm test` |
| Chromium sandbox、popup 關閉、導向後與領點前 URL 驗證 | `test/unit/browser-manager.test.ts`、`test/unit/channel-session.test.ts`、Docker smoke | `npm test`、`./scripts/docker-smoke.sh` |

Reward click 已由 Playwright 對 `test/mock-pages/**` 的 E2E 測試覆蓋；跨模組整合測試不重複模擬 DOM 點擊。

2026-06-14 最終驗收結果：

- `npm run lint`：通過。
- `npm run build`：通過。
- `npm test`：14 個檔案、213 項測試通過。
- `npm run test:integration`：3 個檔案、4 項測試通過。
- `npm run test:e2e`：10 項 Playwright 測試通過。
- `npm audit --omit=dev`：0 個已知漏洞。
- `./scripts/docker-smoke.sh`：通過；包含測試與 production image build、image 敏感檔案檢查、Chromium sandbox、唯讀 root filesystem、缺設定失敗、Compose up、restart 與 SIGTERM。
