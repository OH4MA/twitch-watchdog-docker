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

## 維護原則

- 不要重新加入 Twitch Drops 自動領取或舊 GraphQL claim 流程。
- 不要實作自動輸入 Twitch 帳號密碼、多帳號批量管理、CAPTCHA 繞過、反偵測或平台限制規避。
- `storage-state.json`、`.env`、`config.yml`、token、cookie 與 Telegram Chat ID 不得提交。
- Twitch 播放器 DOM 不是穩定公開 API；selector 變更應集中在 `src/browser` 並以 mock pages 覆蓋。
- 播放最佳化或 Bonus Points 領取失敗不得中止觀看 session。
- Twitch 內容警示確認失敗應回報明確健康檢查原因，不得誤判為登入或離線。
  Content-warning confirmation failures should report a specific health reason and must not be treated as login or offline states.
- Twitch API 暫時失敗時，不得把既有 active session 全部當成離線關閉。

## 版本控制注意事項

`.gitignore` 已排除本機依賴、建置輸出、測試輸出、憑證、登入狀態、benchmark CSV、`.agents/`、`.codex/` 與開發用途 `doc` 文件。若某些 `doc` 檔案已被 Git 追蹤，`.gitignore` 不會自動取消追蹤；需要移除時請另外使用 `git rm --cached` 並確認團隊希望這麼做。
