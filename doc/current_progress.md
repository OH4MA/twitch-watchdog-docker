# Twitch Watchdog 當前進度與交接

更新日期：2026-07-05

## 交接摘要

2026-06-17 最新實作進度：

- 已新增 Twitch Page 定時重整機制，預設 `browser.page_refresh_interval_seconds: 300`，也就是 5 分鐘。
- 定時重整使用每頻道穩定 jitter，最多額外錯開 60 秒，避免多個 Twitch Page 同時 reload 造成 CPU、記憶體與網路尖峰。
- 定時與手動重整都共用 `ChannelSession` 的 reload 流程，reload 後會重新執行播放器最佳化。
- 新增 Telegram `/refresh` 指令，可查詢 active sessions 下一次播放器重整倒數與下次重整時間。
- 新增 Telegram `/refresh_now` 與 `/refresh_now <channel>` 指令，可手動重整全部或指定觀看中頻道。
- scheduled refresh 與 manual refresh 開始時都會透過 Telegram 對 allowed chats 廣播提醒。
- `SessionManager` 新增只讀 refresh 狀態查詢與手動重整協調方法，Telegram 不直接操作 Playwright Page。
- 播放器最佳化已針對 Picture-in-picture 誤觸做防護：選畫質時排除 Picture-in-picture 選項，並在 video 元素設定 `disablePictureInPicture = true`。
- `README.md`、`config.example.yml`、測試 fixture 與本交接文件已同步更新。

2026-06-25 補充：

- Bonus Channel Points 領取 click timeout 已改為 3 秒，避免 Twitch DOM click 卡住時拖滿 Playwright 預設 30 秒。
- 一般 Playwright click 失敗時會對同一個已驗證候選按鈕補一次 DOM click fallback。
- 同一頻道忠誠點數連續領取失敗 10 次時會先重整該頻道頁面。
- 重整後若再次連續領取失敗 10 次，會記錄 `container_restart_requested` 並以非 0 狀態結束程序，交由 Docker `restart: unless-stopped` 重啟容器。
- 相關 log 仍走既有 stdout JSON Lines，可用 `docker compose logs --no-log-prefix twitch-watchdog | rg 'reward_claim_failure|container_restart_requested'` 查詢。

2026-06-28 補充：

- 已新增 Discord Bot，邏輯參考 Telegram Bot，但使用 Discord Gateway 接收 slash command，使用 Discord REST API 回覆 interaction、註冊 commands、發送通知與上傳截圖。
- Discord 支援 server channel 白名單與私訊 user 白名單；若啟用 Discord，必須至少設定 `allowed_channel_ids` 或 `allowed_user_ids` 其中之一。
- Discord 長時間操作會先 deferred response，再 edit original response，避免 Discord interaction 3 秒逾時造成 `discord_config_update_failed` 或 `discord_gateway_message_failed`。
- Telegram 與 Discord 可以同時啟用，通知與管理命令會透過 app composition fan-out 到已啟用的 bot。
- 設定來源已簡化為單一 `config.yml`；Docker Compose 只保留 `CONFIG_PATH`，不再透過 `.env` 傳入 Twitch、Telegram 或 Discord secrets。
- `config.example.yml` 已改用空字串 placeholder，Telegram chat ID 與 Discord snowflake ID 範例都以 quoted numeric string 表示，避免誤導使用者填 `@username`、`#channel` 或頻道名稱。
- 已移除 `.env.example`，真實 `.env` 仍由 `.gitignore` 排除。
- Twitch 登入輔助工具與自動瀏覽器偵測相關變更已回朔；目前仍使用原本的 Playwright storage-state 流程。

2026-06-29 補充：

- `preview` 分支已完成實機 overnight 測試，使用者回報未發現明顯問題。
- 已把 `preview` 以 fast-forward 方式合併回 `master`，目前 `master`、`origin/master`、`preview`、`origin/preview` 都指向 `40fafc9 fix: retry session startup after browser closure`。
- 先前為排查未登入而放寬的 health check 行為已移除：不再把泛用 `video` selector 當成 live content，`login_required` 仍優先於 live content 判斷，mock 測試也回到單一 health marker。
- `BrowserManager`、`ChannelSession` 已拆分為較小模組，新增 Playwright adapter、`ChannelHealthChecker`、channel URL helper 與安全 logging helper； public export 維持既有入口。
- Telegram 與 Discord command 共用 `BotCommandContext`，避免兩套 bot 重複持有相同 runtime 操作。
- 正式 runtime 的 `DefaultSessionManager` 已啟用 session startup 保護：啟動新 session 之間錯開 1 秒；遇到 browser/page 剛關閉造成的 startup failure 時，等待 2 秒後重試 1 次。
- 新增 `session_start_retry_scheduled` log event；若重試後仍失敗，仍會記錄 `session_start_failed`，且該頻道不會留在 active registry。
- 不需要新增使用者設定項；上述 startup stagger/retry 目前由 `createDefaultRuntime` 注入。

2026-07-02 補充：

- 針對實機 log 出現 page crash 後長時間 `scheduler_tick_skipped` / `reason: in_flight` 的狀況，已補 BrowserManager resource close timeout 保護。
- `BrowserManager` 關閉 page、context、browser 時現在會套用預設 10 秒 `resourceCloseTimeoutMs`，避免 Playwright close promise 永久卡住並阻塞後續 page/session 重建。
- 新增 `browser_page_close_timeout`、`browser_context_close_timeout`、`browser_close_timeout` 等 timeout 事件；page close 超時後會釋放 BrowserManager queue，讓同一 channel 後續可重新建立 page。
- 新增 debug level 診斷事件，可透過 `log_level: debug` 啟用：
  - `scheduler_tick_started` / `scheduler_tick_selection` / `scheduler_tick_completed` / `scheduler_tick_failed`
  - `session_reconcile_started` / `session_reconcile_completed`
  - `session_invalidate_started` / `session_invalidate_completed`
  - `session_start_attempt_started` / `session_start_attempt_completed`
  - `browser_page_invalidation_started` / `browser_page_invalidation_completed` / `browser_page_invalidation_notified`
  - `browser_resource_close_started` / `browser_resource_close_completed`
- `README.md` 與 `README_DEV.md` 已新增 debug log 啟用與 `docker compose logs --no-log-prefix twitch-watchdog | rg ...` 查詢範例。
- 已跑過 `npm run build`、`npm run lint`、`npm run test:unit`、`npm run test:integration`；未跑 E2E / Docker smoke。

2026-07-05 補充：

- 針對實機 log 出現忠誠點數領取後 page crash、重整失敗、長時間 `scheduler_tick_skipped` / `reason: in_flight`，且 Telegram `/screenshot` 無回應的狀況，已新增 session lifecycle timeout 與容器級 scheduler stall watchdog。
- `DefaultSessionManager` 現在會對 `session.start()` / `session.stop()` 套用總時間上限；正式 runtime 使用 `max(60s, browser.navigation_timeout_ms * 2)`。超時會記錄 `session_start_timeout` 或 `session_stop_timeout`，並釋放 reconcile，避免 scheduler 永久卡在 in-flight。
- `SessionManager.captureScreenshot()` 現在會隔離單一 stale session 截圖錯誤，記錄 `session_screenshot_failed`，未指定頻道時會依 registry 順序 fallback 到下一個可截圖 session。
- Telegram command 失敗現在會在 `telegram_command_failed` 帶上已遮罩的 `error`，避免只留下 `updateId`；`/screenshot` 對單一頻道截圖失敗會記錄 `telegram_screenshot_failed` 並繼續傳送其他 active session 截圖。
- 新增 `SchedulerStallWatchdog` application integration：若 scheduler `checkInFlight` 持續超過門檻，會記錄 `scheduler_stall_detected`、flush log，然後以非 0 狀態結束程序，交由 Docker `restart: unless-stopped` 重啟容器。
- 容器級 watchdog 目前檢查週期為 `min(60s, check_interval_seconds)`，卡住門檻為 `max(10 分鐘, check_interval_seconds * 5)`；預設 `check_interval_seconds: 60` 時，scheduler 卡住超過 10 分鐘會觸發容器重啟。
- `README.md` 與 `README_DEV.md` 已同步新增 `scheduler_stall_detected`、容器級 watchdog 說明與 log 查詢範例。
- 已跑過 `npm run lint`、`npm run build`、`npm test`；目前 22 個 test files、301 tests 通過。未跑 E2E / Docker smoke。

目前工作區狀態重點：

- 本文件更新前 `git status --short` 顯示已修改 `README.md`、`README_DEV.md`、`src/app/createApplication.ts`、`src/app/index.ts`、`src/sessions/SessionManager.ts`、`src/telegram/TelegramBot.ts`、`test/unit/session-manager.test.ts`、`test/unit/telegram-bot.test.ts`，並新增 `src/app/SchedulerStallWatchdog.ts`、`test/unit/scheduler-stall-watchdog.test.ts`。
- Discord 與單一設定檔相關修改集中於：`README.md`、`README_DEV.md`、`Dockerfile`、`docker-compose.yml`、`config.example.yml`、`src/app/createApplication.ts`、`src/app/AppRunner.ts`、`src/config/AppConfig.ts`、`src/config/ConfigLoader.ts`、`src/discord/`、`test/unit/`、`test/docker/` 與 `scripts/docker-smoke.sh`。
- 2026-06-29 preview merge 相關修改集中於：`src/browser/BrowserManager.ts`、`src/browser/ChannelSession.ts`、`src/browser/ChannelHealthChecker.ts`、`src/browser/adapters/`、`src/browser/types.ts`、`src/browser/channel-url.ts`、`src/browser/safe-logging.ts`、`src/notifications/BotCommandContext.ts`、`src/sessions/SessionManager.ts`、`src/app/createApplication.ts`、`src/telegram/TelegramBot.ts`、`src/discord/DiscordBot.ts`、`README_DEV.md` 與相關 unit tests。
- 2026-07-02 debug/timeout 相關修改集中於：`src/browser/BrowserManager.ts`、`src/browser/types.ts`、`src/scheduler/WatchdogScheduler.ts`、`src/sessions/SessionManager.ts`、`README.md`、`README_DEV.md` 與相關 unit tests。
- 2026-07-05 session timeout、Telegram screenshot fallback 與容器級 watchdog 相關修改集中於：`src/sessions/SessionManager.ts`、`src/telegram/TelegramBot.ts`、`src/app/SchedulerStallWatchdog.ts`、`src/app/createApplication.ts`、`src/app/index.ts`、`README.md`、`README_DEV.md` 與相關 unit tests。
- 登入工具回朔後，`scripts/twitch-login.mjs`、`npm run twitch:login`、README 內 CDP／自動瀏覽器偵測說明，以及 `.gitignore` 的 `data/login-profile/` 不應存在於目前進度。
- `doc/current_progress.md` 仍屬開發交接文件，已在 `.gitignore` 中；除非使用者要求，不要改變其 Git 追蹤狀態。
- 不要提交或輸出真實 Twitch、Telegram、Discord token、cookie、Chat ID、Discord snowflake ID、storage state 或本機部署設定。

給下一位 Agent 的文件決策：

- `README.md` 是主要使用者 README，不應放開發測試、benchmark、runtime resource snapshot、JSON Lines 日誌查詢等內容。
- `README_DEV.md` 是開發者 README，這些開發、測試、資源觀察與維護資訊應集中放在這裡。
- `doc/` 內需求、設計、任務、prompt、交接與最佳化記錄屬於開發用途文件；目前已列入 `.gitignore`。
- `.env.example` 已移除；`config.example.yml` 是唯一範例設定檔。真實 `config.yml` 與 `.env` 不應提交。

目前專案已完成 Twitch Drops 功能移除、第一階段資源最佳化、播放器定時／手動重整、Picture-in-picture 誤觸防護、Discord Bot 整合、單一 `config.yml` 設定流程、browser/session 模組拆分、session startup stagger/retry、page crash / scheduler 卡住排查用 debug log、browser resource close timeout、session lifecycle timeout、Telegram screenshot stale-session fallback，以及 scheduler stall 容器級 watchdog。

目前分支狀態：

- `master`
- `origin/master`
- `preview`
- `origin/preview`
- 四者目前皆在 `40fafc9 fix: retry session startup after browser closure`；下一位 Agent 應先用 `git log --oneline -5` 與 `git status --short --branch` 確認狀態。
- preview merge 前基準 commit：`659974a update gitignore`
- preview 第一個 commit：`b648d12 refactor: split browser modules and bot command context`
- preview 第二個 commit：`40fafc9 fix: retry session startup after browser closure`
- 舊最佳化功能 commit：`600f9c2 深度最佳化 Twitch 觀看資源使用`
- 前一個 commit：`b82081f 移除 Twitch Drops 自動領取功能`

`config.yml`、`.env` 與 `data/browser-state/` 已由 `.gitignore` 排除，禁止提交憑證、cookie、token、Telegram Chat ID、Discord snowflake ID 或 storage state。

## 專案功能

本專案使用 Node.js、TypeScript、Playwright Firefox 與 Docker：

- 透過 Twitch Helix API 監控頻道開台狀態。
- 依 `channels` 順序與 `max_concurrent_streams` 選擇實際觀看頻道。
- 所有頻道共用一個 Firefox Browser 與 Browser Context，每個觀看頻道各有一個 Page。
- 自動領取 Bonus Channel Points。
- Telegram 與 Discord 可查詢狀態、管理頻道、暫停或恢復排程、取得多頻道截圖、查看播放器重整倒數及手動重整觀看頁。
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
- `/refresh`
- `/refresh_now`
- `/refresh_now <channel>`
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
`/refresh` 會回傳 active session 的下一次播放器定時重整倒數；scheduled refresh 開始時會透過 Telegram 廣播提醒。
`/refresh_now` 可手動重整全部 active sessions，指定 channel 時只重整該頻道；manual refresh 開始時也會送出重整提醒。找不到指定 active channel 時會回覆目前可用頻道。

### Discord

主要檔案：

- `src/discord/DiscordApiClient.ts`
- `src/discord/DiscordBot.ts`
- `src/discord/index.ts`
- `src/app/createApplication.ts`

支援指令與 Telegram 管理面一致：

- `/status`
- `/channels`
- `/refresh`
- `/refresh_now`
- `/refresh_now channel:<channel>`
- `/config`
- `/channel_add channel:<channel>`
- `/channel_remove channel:<channel>`
- `/channels_set channels:<channel1,channel2>`
- `/max_streams value:<number>`
- `/check`
- `/pause`
- `/resume`
- `/screenshot`
- `/screenshot channel:<channel>`
- `/help`

目前行為：

- 使用 Discord Gateway 接收 interaction，不需要公開 HTTP callback endpoint。
- 使用 REST API 註冊 application commands、回覆 interaction、編輯 deferred response、發送通知與上傳截圖。
- 支援 `allowed_channel_ids` 限制伺服器文字頻道。
- 支援 `allow_direct_messages` 與 `allowed_user_ids` 限制可私訊使用 bot 的使用者。
- 若啟用 Discord，`bot_token` 與 `application_id` 必填，且 `allowed_channel_ids` 或 `allowed_user_ids` 至少需要一個有效項目。
- `guild_id` 是 Discord server ID；有設定時可註冊 guild commands，通常比全域 commands 更快生效。
- `discord.bot_token` 已加入 AppRunner redaction，錯誤與狀態輸出不得洩漏 token。

### Twitch API Token

主要檔案：

- `src/twitch/TwitchApiClient.ts`
- `src/config/ConfigLoader.ts`

目前行為：

- `twitch_api.client_id` 必填。
- 建議設定 `twitch_api.client_secret`，由 Client Credentials flow 自動取得 App Access Token。
- Token 只保存在程序記憶體。
- 預設每小時驗證；剩餘效期低於 24 小時時更新。
- Helix HTTP 401 時強制更新一次並重試。
- `twitch_api.access_token` 僅作手動備援。

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
3. 選擇畫質時會排除 Picture-in-picture 選項，並在 video 元素設定 `disablePictureInPicture`。
4. 播放器自動靜音。
5. viewport 維持原本 `1280x720`，避免改變 Telegram 截圖版面。
6. 圖片、字型及 tracking 阻擋可設定，但預設全部關閉以保留截圖內容。
7. 健康檢查預設 60 秒，Bonus Points 檢查預設 30 秒。
8. 週期工作改為自排程 `setTimeout`，並使用每頻道固定 jitter 錯開 CPU 峰值。
9. 健康檢查不再讀取完整 `body.textContent()`。
10. 每 300 秒輸出 `runtime_resource_snapshot`。
11. `npm run benchmark:csv` 可將 JSONL 資源事件轉成 CSV。
12. 每 300 秒定時重整 Twitch Page，並以每頻道穩定 jitter 錯開 reload 峰值。
13. 支援 Telegram 手動重整 active sessions，重整後重新套用低畫質與靜音最佳化。

播放最佳化失敗不得中止 session。啟動時若 Twitch 控制列尚未可用，120 秒後的定期校正會再次嘗試。

## 正式設定

實際 `config.yml` 已設定：

```yaml
browser:
  navigation_timeout_ms: 30000
  page_health_check_interval_seconds: 60
  reward_check_interval_seconds: 30
  page_refresh_interval_seconds: 300
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

敏感設定目前集中在真實 `config.yml`：

```yaml
twitch_api:
  client_id: ""
  client_secret: ""
  access_token: ""
telegram:
  enabled: false
  bot_token: ""
  allowed_chat_ids: []
discord:
  enabled: false
  bot_token: ""
  application_id: ""
  guild_id: ""
  allowed_channel_ids: []
  allow_direct_messages: false
  allowed_user_ids: []
```

Docker Compose 只需要 `CONFIG_PATH` 指向設定檔路徑。不要在文件、Git、log 或回覆中輸出實際值。

## 驗證結果

2026-06-29 完成 `preview` 合回 `master` 前後檢查：

- `npm run build`：通過。
- `npm run lint`：通過。
- `npm test`：21 個測試檔、294 項測試通過。
- `git diff --check master..preview`：通過，沒有 whitespace 問題。
- `docker compose build`：通過，production image 可建置。
- 合併方式：`git checkout master && git merge --ff-only preview`，沒有 merge commit，沒有改寫歷史。
- 合併後確認 `master`、`origin/master`、`preview`、`origin/preview` 都在 `40fafc9`。

2026-06-28 完成 Discord Bot、單一 `config.yml` 流程，並回朔 Twitch 登入工具變更後：

- `npm run lint`：通過。
- `npm run build`：通過。
- `npm test`：21 個測試檔、292 項測試通過。
- `docker compose config --format json | node test/docker/verify-compose.mjs service`：通過。
- 回朔登入工具後尚未重跑 `./scripts/docker-smoke.sh`；先前在回朔前曾跑過 Docker smoke 並通過，但最終狀態仍應由下一位 Agent 視需要重跑確認。

2026-06-17 本輪完成播放器重整與 Picture-in-picture 防誤觸後：

- `npm run lint`：通過。
- `npm run build`：通過。
- `npm test`：19 個測試檔、267 項測試通過。
- `git diff --check`：通過。
- 曾嘗試 `npx playwright test test/e2e/playback-optimizer.spec.ts`，但本機 macOS managed sandbox 阻擋 Chromium Mach port，錯誤為 `bootstrap_check_in ... Permission denied`；這是已知本機環境限制，應改用 Docker 或允許瀏覽器所需權限的環境執行 E2E。

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

2026-06-29 preview overnight 實機測試：

- 使用者將 `preview` 部署到 server 實測一晚，未發現明顯問題。
- 使用者曾確認相同 `storage-state.json` 在 `master` 與 `preview` 都能登入；先前未登入判斷後來確認與不同 server 環境有關，不是 preview 程式邏輯造成。
- 測試期間曾觀察到啟動初期 `browser_disconnected`、多個 `page_closed`，以及 `page.goto: Target page, context or browser has been closed`；手動重啟容器後恢復正常。
- 因上述啟動期 browser/page close 現象，`SessionManager` 現在會在正式 runtime 對新 session 啟動錯開 1 秒，並對可判定為 browser/page 剛關閉的啟動失敗重試 1 次。
- 若未來 log 出現 `session_start_retry_scheduled`，代表這個保護被觸發；若後續沒有 `session_start_failed`，通常表示重試已恢復。

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
8. Telegram `/refresh_now` 可觸發所有 active sessions 同時重整；目前由每個 session 的 reload 流程保護重入，但使用者仍應避免短時間連續大量手動觸發。
9. Picture-in-picture 防護已排除明確 PiP 選項並設定 `disablePictureInPicture`，但 Twitch 播放器 DOM 仍可能改版，若仍誤觸應優先修改 `StreamPlaybackOptimizer`。
10. 啟動期若 Twitch、Firefox 或 container runtime 造成 browser/page 剛關閉，可能會看到 `session_start_retry_scheduled`；這是預期復原流程。只有後續出現 `session_start_failed` 或 active session 長期缺失時才需要深入排查。
11. 不要重新實作 Twitch Drops claim、integrity header 模擬、CAPTCHA、反偵測或平台限制規避。

## 下一位 Agent 優先事項

1. 若要量化效能，執行 1／2／3 個頻道各至少 15 分鐘的正式 benchmark，排除前 3 分鐘暖機。
2. preview 已有一晚實機觀察且未見明顯問題；後續仍可在正式 `master` 部署後確認 Channel Points、Bonus claim、截圖、page health、定時重整、Telegram/Discord 管理指令與 browser restart。
3. 收集 CPU 平均值、P95、最大值、記憶體平均與最大值，不要只使用單次 `docker stats`。
4. 使用 `runtime_resource_snapshot` 與 `npm run benchmark:csv` 保存可比較資料。
5. 實機驗證 `/refresh` 倒數、`/refresh_now` 全部／指定頻道、找不到頻道提示，以及 scheduled/manual refresh 的 Telegram 提醒。
6. 觀察啟動期是否還會出現連續 `session_start_failed`；若只有單次 `session_start_retry_scheduled` 且後續成功，通常不需要處理。
7. 若 Twitch 畫質選擇器失效或仍誤觸 Picture-in-picture，只修改 `StreamPlaybackOptimizer`，且失敗必須安全降級。
8. 視 CI 環境補上 Linux、macOS、Windows 主機模式驗證；Docker smoke 可集中在 Linux。

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
