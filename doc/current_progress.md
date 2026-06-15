# Twitch Watchdog 當前進度與交接

更新日期：2026-06-15

## 交接摘要

此專案是以 Node.js、TypeScript、Playwright 與 Docker 實作的 Twitch
頻道監控服務。服務會透過 Twitch API 判斷頻道是否開台，為活躍頻道建立
瀏覽器工作階段、檢查頁面健康狀態及領取忠誠點數，並可透過 Telegram
接收狀態與截圖指令。

目前工作樹包含大量尚未提交的功能修改。不要重設或丟棄現有變更。

最新需求是 Twitch API 只需設定 Client ID 與 Client Secret，服務啟動後
自動取得 App Access Token，後續驗證及更新 Token。程式碼與單元測試已完成，
但最後一版尚未完成 E2E、Docker smoke test 與重新部署。

## 工作樹狀態

- 分支：`master`
- 目前有 34 個已追蹤檔案被修改，約 816 行新增、42 行刪除。
- 尚未建立 Git commit。
- 舊文件 `doc/tasks/progress.md` 是初始階段紀錄，部分內容仍以 Chromium
  為準；本文件才是目前交接基準。
- `.env`、`config.yml` 與 `data/browser-state/` 已由 `.gitignore` 排除。
- 不可提交 `.env`、Twitch Token、Client Secret、Telegram Bot Token 或
  Playwright `storage-state.json`。

## 已完成項目

### Bonus Channel Points 與 Twitch Drops

主要檔案：

- `src/browser/RewardClaimer.ts`
- `src/browser/DropClaimer.ts`
- `src/browser/ChannelSession.ts`
- `src/telegram/TelegramBot.ts`

已參考 BetterTTV 目前實作完成：

- Bonus Channel Points 支援 `.claimable-bonus__icon` selector。
- 排除 destructive control 與有 `aria-label` 的餘額選單按鈕。
- 從 Twitch 頁面 React tree 找到既有 Apollo client。
- 查詢 Drops inventory，只領取已達觀看分鐘、前置條件完成且尚未領取的項目。
- 缺少 `dropInstanceID` 時使用 `userId#campaignId#dropId` fallback。
- 多頻道共用單一 Drops 領取器，每 60 秒最多查詢一次。
- Drops 失敗不會停止掛台或忠誠點數領取。
- 成功或失敗會寫入結構化日誌並傳送 Telegram 通知。

### Twitch API Token 自動管理

主要檔案：

- `src/twitch/TwitchApiClient.ts`
- `src/config/AppConfig.ts`
- `src/config/ConfigLoader.ts`
- `src/app/createApplication.ts`
- `docker-compose.yml`
- `config.example.yml`

目前行為：

- `TWITCH_CLIENT_ID` 必填。
- `TWITCH_CLIENT_SECRET` 可供 Client Credentials 流程使用。
- `TWITCH_ACCESS_TOKEN` 已改成非必要的相容性備援。
- 沒有初始 Access Token 時，第一次查詢開台狀態前會呼叫
  `https://id.twitch.tv/oauth2/token` 取得 App Access Token。
- Token 只保存在記憶體，不會回寫 `.env`。
- 預設每小時驗證 Token。
- Token 剩餘效期低於 24 小時時會自動更新。
- Helix API 回傳 401 時，若有 Client Secret，會強制更新一次 Token 並重試。
- 更新成功會記錄 `twitch_api_token_refreshed`。
- 驗證成功會以 debug 等級記錄 `twitch_api_token_validated`。

本機 `.env` 目前檢查結果：

- `TWITCH_CLIENT_ID`：已設定
- `TWITCH_CLIENT_SECRET`：已設定
- `TWITCH_ACCESS_TOKEN`：未偵測到設定
- Telegram Bot Token 與允許的 Chat ID：已設定

以上只記錄是否存在，不得把實際值加入文件或 commit。

### Twitch Error #4000 與瀏覽器相容性

主要檔案：

- `src/browser/BrowserManager.ts`
- `src/browser/ChannelSession.ts`
- `Dockerfile`

已確認 Chromium/headless shell 在測試環境播放 Twitch 時可能缺少 H.264
支援，頁面會顯示：

`This video is either unavailable or not supported in this browser. (Error #4000)`

已完成：

- Playwright 瀏覽器由 Chromium 切換為 Firefox。
- 頁面健康檢查會辨識 Error #4000，並回報 `error_page`。
- Docker 容器新增 `HOME`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME` 至 `/tmp`
  的設定，以支援唯讀 root filesystem 下的完整瀏覽器執行。
- 隔離測試中 Firefox 可正常播放 Twitch，影片未暫停且播放時間持續增加。
- 先前部署版本已觀察兩輪 30 秒健康檢查，未出現
  `page_health_failed`。

### Telegram 即時截圖

主要檔案：

- `src/browser/ChannelSession.ts`
- `src/sessions/SessionManager.ts`
- `src/telegram/TelegramApiClient.ts`
- `src/telegram/TelegramBot.ts`

已完成：

- `/screenshot`
- `/screenshot <channel>`
- 從目前活躍的瀏覽器頁面擷取 PNG。
- 使用 Telegram `sendPhoto` multipart API 直接傳送。
- 截圖保存在記憶體，不寫入磁碟。
- `/help` 已加入截圖指令說明。
- Bot 啟動時會註冊 Telegram 原生 `/` 指令選單。
- 啟動通知、`/start` 與 `/help` 會顯示持續按鈕鍵盤。
- `/config` 可查看頻道與最大同時觀看設定。
- `/channel_add`、`/channel_remove`、`/channels_set` 可更新頻道清單。
- `/max_streams` 可更新 `max_concurrent_streams`。
- 更新會立即套用並持久化回 `config.yml`。

需要在重新部署後以實際 Telegram Bot 再測一次，例如：

`/screenshot neipuduck`

### 忠誠點數領取修正

主要檔案：

- `src/browser/RewardClaimer.ts`
- `test/unit/reward-claimer.test.ts`
- `test/e2e/reward-claimer.spec.ts`

已修正備援 selector 誤把 Twitch 的 `Bits and Points Balances` 按鈕當成
「領取忠誠點數」按鈕的問題，並補上單元與 E2E 測試案例。

### storageState 與敏感設定

- Twitch 登入狀態已成功匯出至本機忽略的
  `data/browser-state/storage-state.json`。
- 先前驗證過 storageState 內含有效登入 cookie。
- 檔案權限曾設為 `600`。
- 容器以唯讀方式掛載 `/data/browser-state`。
- 不可在 log、文件或 commit 中顯示 cookie 或 Token 值。

## 測試紀錄

在「Access Token 改為可省略，啟動時用 Client Secret 取得第一個 Token」
的最新修改後，已通過：

```text
npm run lint
npm run build
npm test
```

Vitest 結果：

- 18 個測試檔案通過
- 249 個測試通過

Bonus Channel Points 與 Drops 修改後另已通過：

- 13 個 Playwright E2E 測試

另已用以下條件驗證 Compose 設定：

- `TWITCH_ACCESS_TOKEN` 為空
- `TWITCH_CLIENT_SECRET` 有值
- `node test/docker/verify-compose.mjs service` 通過

在前一版功能整合時曾通過：

- 230 個 Vitest 測試
- 11 個 E2E 測試
- Docker smoke test

但前述完整驗證是在「啟動仍需初始 Access Token」的版本完成，不能取代
最新 Token 啟動流程的重新驗證。

## 尚未完成與風險

1. 最新版本尚未執行 `./scripts/docker-smoke.sh`。
2. 最新版本尚未重新執行 `docker compose build` 與部署。
3. 本次交接因沙箱無權連線 OrbStack Docker socket，無法確認容器當前狀態。
4. 目前執行中的容器若仍存在，很可能是最後一次修改前的映像，不應視為
   已包含「無 Access Token 啟動」功能。
5. `TwitchApiClient` 的 401 更新後重試流程已有測試，但部署前仍應檢查
   timeout 清理及錯誤分類是否符合預期。
6. Drops 依賴 Twitch 未公開的 React/Apollo 內部結構，網站改版後可能需要
   更新 client 探索方式或 GraphQL schema。
7. 最終目標環境是 Debian Linux x86_64；目前主要實機驗證是在 macOS
   ARM64/OrbStack，仍需在目標主機執行 Docker smoke test。

## 下一位 Agent 操作順序

1. 先閱讀本文件、`git status` 與目前 diff，不要還原既有修改。
2. 確認 `.env` 的 Client ID 與 Client Secret 存在，但不要輸出值。
3. 執行完整程式驗證：

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```

4. 執行容器驗證：

```bash
./scripts/docker-smoke.sh
docker compose build
docker compose up -d --force-recreate
docker compose ps
docker compose logs -f twitch-watchdog
```

5. 啟動時確認沒有設定 `TWITCH_ACCESS_TOKEN` 仍可出現
   `twitch_api_token_refreshed`，接著正常出現服務啟動及頻道監控 log。
6. 確認活躍 Twitch 頁面沒有 Error #4000 或 `page_health_failed`。
7. 透過 Telegram 測試 `/status`、`/screenshot` 與
   `/screenshot <channel>`。
8. 在 Debian x86_64 目標主機重跑 smoke test 與實際頻道監控。
9. 全部通過後再整理並建立 commit；目前沒有任何 commit 可供回退。

## 常用操作

停止但保留容器：

```bash
docker compose stop
```

停止並移除容器與網路：

```bash
docker compose down
```

查看近期 log：

```bash
docker compose logs --tail=200 twitch-watchdog
```

持續追蹤 log：

```bash
docker compose logs -f twitch-watchdog
```

## 重要安全與部署設定

- 容器使用非 root 使用者 `pwuser`。
- root filesystem 設為唯讀。
- `/tmp` 使用 tmpfs。
- 啟用 `no-new-privileges`。
- 使用專案內的 seccomp profile。
- `storage-state.json` 以唯讀 volume 掛載。
- 官方 Playwright 映像可用於 `linux/amd64` 與 `linux/arm64`，但仍需在
  實際 Debian x86_64 主機驗證。
