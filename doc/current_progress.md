# Twitch Watchdog 當前進度與交接

更新日期：2026-06-15

## 交接摘要

目前專案已完成 Twitch Drops 功能移除與第一階段資源最佳化。最佳化分支已 fast-forward 合併至 `master`，本機與遠端最佳化分支均已刪除。

目前唯一開發分支：

- `master`
- `origin/master`
- 最新功能 commit：`600f9c2 深度最佳化 Twitch 觀看資源使用`
- 前一個 commit：`b82081f 移除 Twitch Drops 自動領取功能`

工作區在本文件更新前為乾淨狀態。`config.yml`、`.env` 與 `data/browser-state/` 已由 `.gitignore` 排除，禁止提交憑證、cookie、token、Telegram Chat ID 或 storage state。

## 專案功能

本專案使用 Node.js、TypeScript、Playwright Firefox 與 Docker：

- 透過 Twitch Helix API 監控頻道開台狀態。
- 依 `channels` 順序與 `max_concurrent_streams` 選擇實際觀看頻道。
- 所有頻道共用一個 Firefox Browser 與 Browser Context，每個觀看頻道各有一個 Page。
- 自動領取 Bonus Channel Points。
- Telegram 可查詢狀態、管理頻道、暫停或恢復排程及取得多頻道截圖。
- 使用 Client ID 與 Client Secret 自動取得、驗證及更新 Twitch App Access Token。
- Firefox 可避免 Linux ARM64 Chromium 缺少 H.264 解碼能力造成 Twitch Error #4000。

Twitch Drops 自動領取已完全移除，不應重新加入舊的 GraphQL claim 流程。Twitch 已以 integrity check 拒絕非官方 claim，原功能會持續產生 `drop_claim_failed`。

## 主要功能狀態

### Bonus Channel Points

主要檔案：

- `src/browser/RewardClaimer.ts`
- `src/browser/ChannelSession.ts`

目前支援：

- Twitch `community-points-claim-button`。
- BetterTTV `.claimable-bonus__icon`。
- 排除 destructive control 與帶 `aria-label` 的餘額選單。
- 成功後同一頻道套用 60 秒冷卻。
- 領取失敗只記錄事件，不中止觀看 session。

### Telegram

主要檔案：

- `src/telegram/TelegramApiClient.ts`
- `src/telegram/TelegramBot.ts`
- `src/config/RuntimeConfigManager.ts`

支援指令：

- `/status`
- `/channels`
- `/config`
- `/channel_add <channel>`
- `/channel_remove <channel>`
- `/channels_set <channel1,channel2>`
- `/max_streams <number>`
- `/check`
- `/pause`
- `/resume`
- `/screenshot`
- `/screenshot <channel>`
- `/help`

`/screenshot` 會依 active session 順序回傳所有觀看中頻道的 PNG；指定頻道時只回傳該頻道。截圖只存在記憶體，不寫入磁碟。

### Twitch API Token

主要檔案：

- `src/twitch/TwitchApiClient.ts`
- `src/config/ConfigLoader.ts`

目前行為：

- `TWITCH_CLIENT_ID` 必填。
- 建議設定 `TWITCH_CLIENT_SECRET`，由 Client Credentials flow 自動取得 App Access Token。
- Token 只保存在程序記憶體。
- 預設每小時驗證；剩餘效期低於 24 小時時更新。
- Helix HTTP 401 時強制更新一次並重試。
- `TWITCH_ACCESS_TOKEN` 僅作手動備援。

## 已完成資源最佳化

主要檔案：

- `src/browser/StreamPlaybackOptimizer.ts`
- `src/browser/ChannelSession.ts`
- `src/browser/BrowserManager.ts`
- `src/app/RuntimeResourceMonitor.ts`
- `scripts/resource-snapshots-to-csv.mjs`
- `doc/optimization.md`

已完成：

1. 預設將 Twitch 直播設為 `160p`，每 120 秒重新校正。
2. 支援 Twitch 新版無 `data-a-target` 的 `role="menuitemradio"` 畫質選項。
3. 播放器自動靜音。
4. viewport 維持原本 `1280x720`，避免改變 Telegram 截圖版面。
5. 圖片、字型及 tracking 阻擋可設定，但預設全部關閉以保留截圖內容。
6. 健康檢查預設 60 秒，Bonus Points 檢查預設 30 秒。
7. 週期工作改為自排程 `setTimeout`，並使用每頻道固定 jitter 錯開 CPU 峰值。
8. 健康檢查不再讀取完整 `body.textContent()`。
9. 每 300 秒輸出 `runtime_resource_snapshot`。
10. `npm run benchmark:csv` 可將 JSONL 資源事件轉成 CSV。

播放最佳化失敗不得中止 session。啟動時若 Twitch 控制列尚未可用，120 秒後的定期校正會再次嘗試。

## 正式設定

實際 `config.yml` 已設定：

```yaml
browser:
  navigation_timeout_ms: 30000
  page_health_check_interval_seconds: 60
  reward_check_interval_seconds: 30
  restart_on_crash: true
  stream_quality: 160p
  enforce_stream_quality_seconds: 120
  viewport_width: 1280
  viewport_height: 720
  mute_audio: true
  block_images: false
  block_fonts: false
  block_known_tracking: false
  resource_telemetry_interval_seconds: 300
```

敏感設定由 `.env` 提供：

```dotenv
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_ACCESS_TOKEN=
TELEGRAM_ENABLED=
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=
```

不要在文件、Git、log 或回覆中輸出實際值。

## 驗證結果

2026-06-15 在 `master` commit `600f9c2` 完成：

- `npm run lint`：通過。
- `npm run build`：通過。
- Vitest：19 個測試檔、257 項測試通過。
- Playwright E2E：13 項通過。
- Docker smoke：通過。
- Docker smoke 已驗證測試與 production image、缺設定失敗、Compose up、SIGTERM、restart、唯讀 root filesystem 與可寫 `config.yml`。
- `master` 與原最佳化分支合併前已確認內容完全相同。
- Telegram 既有 8 個測試與 RewardClaimer 既有 12 個測試均未減少。

macOS managed sandbox 可能阻擋本機 Playwright 的 Chromium/Firefox Mach port；E2E 應以 Docker 執行。

## 實機驗證與資源觀察

最終設定維持 `1280x720`，圖片、字型與 tracking 阻擋皆關閉。

已確認：

- 三個 active session 正常觀看。
- 三個頻道均持續出現 `stream_playback_optimized`，畫質為 `160p` 且 `muted: true`。
- 三個頻道均成功出現 `reward_claimed`。
- `runtime_resource_snapshot` 顯示 `activeChannelCount: 3`、`browserPageCount: 3`。
- 正式容器狀態為 `running`，restart count 為 `0`。

短時間同為三頻道的單次比較：

| 項目 | 最佳化前 | 最佳化後觀察值 |
| --- | ---: | ---: |
| 容器 CPU | 約 167.9% | 約 130.2% |
| 容器記憶體 | 約 2.749 GiB | 約 2.075 GiB |
| viewport | 1280x720 | 1280x720 |
| 畫質 | Twitch Auto | 160p |

這些是瞬時觀察，不是正式 benchmark。CPU 會隨廣告、直播內容、解碼與主機負載大幅波動；後續曾看到約 199% CPU、2.659 GiB，因此不可宣稱固定改善比例。

## 已知風險

1. Twitch 播放器 DOM 不是公開穩定 API，畫質選擇器可能再次改版。
2. 強制低畫質是否長期維持 Channel Points 累積，仍需至少 2 小時驗收。
3. 圖片、字型與 tracking 阻擋預設關閉；啟用前必須驗證截圖、登入、GraphQL、media 與觀看心跳。
4. `config.yml` 必須讓容器內 `pwuser` 可寫，供 Telegram 持久化設定。
5. `storage-state.json` 等同登入憑證，必須唯讀掛載並維持最小權限。
6. Firefox 在不同 OS、CPU 架構與 container runtime 的解碼效能差異很大。
7. Telegram Bot Token 具有管理能力，必須限制 allowed chat IDs。
8. 不要重新實作 Twitch Drops claim、integrity header 模擬、CAPTCHA、反偵測或平台限制規避。

## 下一位 Agent 優先事項

1. 執行 1／2／3 個頻道各至少 15 分鐘的正式 benchmark，排除前 3 分鐘暖機。
2. 連續運行至少 2 小時，確認 Channel Points、Bonus claim、截圖、page health 與 browser restart。
3. 收集 CPU 平均值、P95、最大值、記憶體平均與最大值，不要只使用單次 `docker stats`。
4. 使用 `runtime_resource_snapshot` 與 `npm run benchmark:csv` 保存可比較資料。
5. 若 Twitch 畫質選擇器失效，只修改 `StreamPlaybackOptimizer`，且失敗必須安全降級。
6. 視 CI 環境補上 Linux、macOS、Windows 主機模式驗證；Docker smoke 可集中在 Linux。

## 常用命令

程式驗證：

```bash
npm run lint
npm run build
npm test
docker build --target smoke-test -t twitch-watchdog:smoke .
./scripts/docker-smoke.sh
```

部署與狀態：

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=200 twitch-watchdog
docker stats twitch-watchdog --no-stream
docker top twitch-watchdog -eo pid,ppid,rss,comm,args
```

遙測轉 CSV：

```bash
docker compose logs --no-log-prefix twitch-watchdog \
  | npm run benchmark:csv --silent \
  > benchmark.csv
```

## 安全與部署原則

- 容器使用非 root `pwuser`。
- root filesystem 唯讀，`/tmp` 使用 tmpfs。
- 啟用 `no-new-privileges` 與專案 seccomp profile。
- `config.yml` 為可寫 bind mount。
- `storage-state.json` 為唯讀 bind mount。
- Browser crash 具有限次自動重啟與 backoff。
- 不提交或輸出 Twitch/Telegram 憑證、cookie、Authorization header 或登入資訊。
