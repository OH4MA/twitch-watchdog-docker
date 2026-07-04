# Twitch Watchdog 開發者文件

本文件提供本機開發、測試與維護資訊。使用者部署流程請見 [README.md](README.md)。

## 專案結構

- `src/config`：YAML 設定、環境變數覆寫、runtime config 持久化。
- `src/credentials`：storageState 與 Twitch API 設定檢查。
- `src/twitch`：Twitch Helix API client 與 live status provider。
- `src/browser`：Playwright browser/context/page、觀看 session、畫質最佳化與 Bonus Points 領取。
  It also handles Twitch content-warning confirmation gates before playback health checks.
- `src/sessions`：多頻道 session reconcile。
- `src/scheduler`：輪詢排程、stream selection 與不可重入控制。
- `src/telegram`：Telegram Bot API 與指令處理。
- `src/discord`：Discord REST API、Gateway WebSocket 與 slash command 處理。
  Discord REST API, Gateway WebSocket, and slash command handling.
- `src/app`：composition root、啟停順序、signal handler 與 runtime resource snapshot。
- `test`：unit、integration、Playwright mock page E2E、Docker smoke 輔助檔。
- `scripts`：維護與觀察用腳本。

`doc/` 內的需求、設計、任務與交接文件是開發用途文件，不是使用者操作手冊。

## 本機需求

- Node.js 24 以上。
- npm 11。
- Docker Engine 與 Docker Compose plugin。
- Playwright Firefox browser。

安裝依賴：

```bash
npm ci
npx playwright install firefox
```

## 常用命令

```bash
npm run lint
npm run build
npm test
npm run test:unit
npm run test:integration
npm run test:e2e
```

本機執行已建置版本：

```bash
npm run build
CONFIG_PATH="$PWD/config.yml" npm start
```

本機開發模式：

```bash
CONFIG_PATH="$PWD/config.yml" npm run dev
```

## Docker 驗證

建置 production image：

```bash
docker compose build
```

執行 smoke test：

```bash
./scripts/docker-smoke.sh
```

Smoke test 會建置測試與正式 targets，檢查 image 不含敏感檔案，驗證缺設定失敗、Compose up、SIGTERM、restart、唯讀 root filesystem 與瀏覽器 sandbox。測試使用假憑證，不會連線 Twitch API 或正式 Twitch 網站。

macOS managed sandbox 可能阻擋本機 Playwright Firefox/Chromium 的 Mach port；若 E2E 在本機失敗，優先以 Docker smoke 或 Linux 環境驗證。

## 測試策略

- Unit tests：純邏輯、設定驗證、錯誤分類與敏感資料遮罩。
- Integration tests：scheduler、session manager、startup prerequisites 與跨模組流程。
- E2E tests：只使用 `test/mock-pages`，不得依賴真實 Twitch 網站狀態。
- Docker smoke：驗證 image、compose、安全掛載與 graceful shutdown。

不得用略過測試、降低斷言或刪除有效測試取得綠燈。

## 資源觀察

服務 log 以 JSON Lines 寫到 stdout；正式 Docker 部署可直接使用 Docker logs 查詢。
Service logs are written as JSON Lines to stdout; production Docker deployments can inspect them through Docker logs.

常用 log 查詢：
Common log queries:

```bash
docker compose logs -f twitch-watchdog
docker compose logs --no-log-prefix twitch-watchdog
docker compose logs --no-log-prefix twitch-watchdog | rg 'reward_claim_failure|container_restart_requested|scheduler_stall_detected'
```

忠誠點數領取復原相關事件：
Reward claim recovery events:

- `reward_claim_failed`：單次忠誠點數領取失敗。
  Single reward claim attempt failed.
- `reward_claim_failure_threshold`：同一頻道連續失敗達復原門檻。
  A channel reached the consecutive failure recovery threshold.
- `reward_claim_failure_recovery_refresh`：因連續失敗觸發該頻道頁面重整。
  A channel page refresh was triggered by consecutive reward failures.
- `container_restart_requested`：重整後仍連續失敗，程序將以非 0 狀態結束，交由 Docker restart policy 重啟容器。
  Reward failures continued after the recovery refresh, so the process exits non-zero and Docker restart policy restarts the container.
- `scheduler_stall_detected`：排程檢查長時間停留在 in-flight，容器級 watchdog 會 flush log 後以非 0 狀態結束程序，交由 Docker restart policy 重啟容器。
  A scheduler check remained in flight past the watchdog threshold, so the service flushes logs and exits non-zero for Docker restart policy recovery.

Session 啟動相關事件：
Session startup events:

- `session_start_retry_scheduled`：啟動 session 時遇到瀏覽器或 page 剛關閉，會短暫等待後重試一次。
  A session start hit a just-closed browser or page, so the manager waits briefly and retries once.
- `session_start_failed`：session 啟動最終失敗；該頻道不會留在 active registry，其他頻道會繼續處理。
  Session startup ultimately failed; that channel is not kept in the active registry, and other channels continue processing.

容器資源：

```bash
docker stats twitch-watchdog --no-stream
docker top twitch-watchdog -eo pid,ppid,rss,comm,args
```

將 runtime resource snapshot 轉為 CSV：

```bash
docker compose logs --no-log-prefix twitch-watchdog \
  | npm run benchmark:csv --silent \
  > benchmark.csv
```

Benchmark 輸出屬於本機開發產物，已由 `.gitignore` 排除。

## 詳細診斷 Log

若要排查排程卡住、Playwright page crash 或瀏覽器資源關閉問題，將 `config.yml` 的 `log_level` 設為 `debug` 後重啟服務：
To diagnose stuck scheduler ticks, Playwright page crashes, or browser resource cleanup issues, set `log_level` to `debug` in `config.yml` and restart the service:

```yaml
log_level: debug
```

常用診斷查詢：
Useful diagnostic queries:

```bash
docker compose logs --no-log-prefix twitch-watchdog \
  | rg 'scheduler_tick_|scheduler_stall_detected|session_(reconcile|invalidate|start_attempt)|browser_(page_invalidation|resource_close)|page_crashed|page_closed|page_refresh_failed'
```

重點事件：
Important events:

- `scheduler_tick_started` / `scheduler_tick_selection` / `scheduler_tick_completed`：確認每輪排程是否有開始、選出哪些觀看頻道、以及是否完成。
  Confirm whether each scheduler tick started, which active channels were selected, and whether the tick completed.
- `scheduler_tick_failed`：排程 tick 發生未預期錯誤，會包含 `tickId`、耗時與已遮罩錯誤訊息。
  Indicates an unexpected scheduler tick failure with `tickId`, duration, and a redacted error message.
- `scheduler_stall_watchdog_started` / `scheduler_stall_detected`：確認容器級 watchdog 的檢查間隔、卡住門檻，以及是否已要求容器重啟。
  Confirms the container-level watchdog interval, stall threshold, and whether it requested container restart recovery.
- `session_reconcile_started` / `session_reconcile_completed`：確認 SessionManager 是否進入 reconcile，以及 start/stop 後的 active session 清單。
  Confirms whether SessionManager entered reconcile and what active sessions remained after start/stop work.
- `session_invalidate_started` / `session_invalidate_completed`：確認 page crash 或 browser restart 是否真的移除 session。
  Confirms whether a page crash or browser restart actually removed the affected session.
- `browser_page_invalidation_started` / `browser_page_invalidation_completed` / `browser_page_invalidation_notified`：確認 BrowserManager 是否收到 page crash/close，是否刪除 page registry，以及是否通知 SessionManager。
  Confirms whether BrowserManager received page crash/close, removed the page registry entry, and notified SessionManager.
- `browser_resource_close_started` / `browser_resource_close_completed` / `browser_page_close_timeout`：確認卡住的是 page、context 或 browser close；timeout 事件代表清理超過保護上限。
  Confirms whether page, context, or browser close is stuck; timeout events mean cleanup exceeded the guard limit.

貼回問題 log 時，請保留同一段時間內的 `scheduler_tick_*`、`session_*`、`browser_*`、`page_*` 與 `runtime_resource_snapshot` 事件。
When sharing logs for debugging, include `scheduler_tick_*`, `session_*`, `browser_*`, `page_*`, and `runtime_resource_snapshot` events from the same time window.

## 維護原則

- 不要重新加入 Twitch Drops 自動領取或舊 GraphQL claim 流程。
- 不要實作自動輸入 Twitch 帳號密碼、多帳號批量管理、CAPTCHA 繞過、反偵測或平台限制規避。
- `storage-state.json`、`config.yml`、token、cookie、Telegram Chat ID、Discord Channel ID 與 Discord User ID 不得提交。
  Do not commit `storage-state.json`, `config.yml`, tokens, cookies, Telegram Chat IDs, Discord Channel IDs, or Discord User IDs.
- Twitch 播放器 DOM 不是穩定公開 API；selector 變更應集中在 `src/browser` 並以 mock pages 覆蓋。
- 播放最佳化或 Bonus Points 領取失敗不得中止觀看 session。
- Twitch 內容警示確認失敗應回報明確健康檢查原因，不得誤判為登入或離線。
  Content-warning confirmation failures should report a specific health reason and must not be treated as login or offline states.
- Twitch API 暫時失敗時，不得把既有 active session 全部當成離線關閉。

## 版本控制注意事項

`.gitignore` 已排除本機依賴、建置輸出、測試輸出、憑證、登入狀態、benchmark CSV、`.agents/`、`.codex/` 與開發用途 `doc` 文件。若某些 `doc` 檔案已被 Git 追蹤，`.gitignore` 不會自動取消追蹤；需要移除時請另外使用 `git rm --cached` 並確認團隊希望這麼做。
