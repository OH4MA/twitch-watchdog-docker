# Twitch Watchdog 當前進度與交接

更新日期：2026-06-15

## 專案摘要

此專案是以 Node.js、TypeScript、Playwright Firefox 與 Docker 實作的 Twitch 頻道監控服務。

目前功能：

- 透過 Twitch Helix API 監控頻道開台狀態。
- 依 `channels` 順序與 `max_concurrent_streams` 選擇實際觀看頻道。
- 為每個實際觀看頻道建立獨立 Twitch Page。
- 自動領取 Bonus Channel Points。
- 透過 Telegram 查詢狀態、擷取截圖及修改頻道設定。
- 使用 Client ID 與 Client Secret 自動取得、驗證及更新 Twitch App Access Token。
- 以 Firefox 避免 Linux ARM64 Chromium 缺少 H.264 解碼能力造成 Twitch Error #4000。

## Git 狀態

- 分支：`master`
- 最新 commit：`7d92adc telegram screenshot 邏輯修改`
- 前一個主要功能 commit：`ab11810 新增獎勵自動領取與 Telegram 設定控制`
- 目前未提交文件：`doc/current_progress.md`、`doc/optimization.md`
- `config.yml`、`.env` 與 `data/browser-state/` 已由 `.gitignore` 排除。

不可提交：

- Twitch Client Secret、Access Token。
- Telegram Bot Token、允許的 Chat ID。
- `data/browser-state/storage-state.json`。
- 任何 cookie、Authorization header 或登入資訊。

## 設定來源

### `.env`

敏感設定與整合開關由環境變數提供：

```dotenv
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_ACCESS_TOKEN=
TELEGRAM_ENABLED=
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=
```

目前建議只設定 `TWITCH_CLIENT_ID` 與 `TWITCH_CLIENT_SECRET`。`TWITCH_ACCESS_TOKEN` 為選填相容性備援。

### `config.yml`

一般執行設定保留在 YAML：

- `channels`
- `check_interval_seconds`
- `max_concurrent_streams`
- `headless`
- `storage_state_path`
- `log_level`
- `browser`

已從 `config.yml` 與 `config.example.yml` 移除重複的 `twitch_api`、`telegram` 區塊。Telegram polling timeout 未設定時預設為 25 秒。

## 已完成功能

### Bonus Channel Points

主要檔案：

- `src/browser/RewardClaimer.ts`
- `src/browser/ChannelSession.ts`

目前行為：

- 支援 Twitch `community-points-claim-button`。
- 支援 BetterTTV 使用的 `.claimable-bonus__icon`。
- 排除 destructive control。
- 排除有 `aria-label` 的餘額選單按鈕，避免誤點 `Bits and Points Balances`。
- 成功後同一頻道套用 60 秒冷卻。
- 領取失敗只記錄事件，不會中止觀看 session。

### Twitch API Token 自動管理

主要檔案：

- `src/twitch/TwitchApiClient.ts`
- `src/config/ConfigLoader.ts`
- `src/app/createApplication.ts`

目前行為：

- `TWITCH_CLIENT_ID` 必填。
- 可使用 `TWITCH_CLIENT_SECRET` 執行 Client Credentials flow。
- 沒有初始 Access Token 時，在第一次 Helix 查詢前自動取得 App Access Token。
- Token 只保存在程序記憶體。
- 預設每小時呼叫 Twitch `/validate`。
- Token 剩餘效期低於 24 小時時自動更新。
- Helix 回傳 HTTP 401 時強制更新一次並重試。
- `TWITCH_ACCESS_TOKEN` 可作為沒有 Client Secret 時的手動備援。

相關事件：

- `twitch_api_token_refreshed`
- `twitch_api_token_validated`
- `twitch_api_auth_failed`
- `twitch_api_rate_limited`

### Firefox 與 Error #4000

主要檔案：

- `src/browser/BrowserManager.ts`
- `src/browser/ChannelSession.ts`
- `Dockerfile`

已完成：

- Production browser 由 Chromium 改為 Firefox。
- 健康檢查會辨識 Error #4000 與不支援影片訊息。
- 容器將 `HOME`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME` 指向 `/tmp`，相容唯讀 root filesystem。
- Browser、Context 與所有 Page 共用同一個登入 storageState。

### Telegram Bot

主要檔案：

- `src/telegram/TelegramApiClient.ts`
- `src/telegram/TelegramBot.ts`
- `src/config/RuntimeConfigManager.ts`
- `src/scheduler/WatchdogScheduler.ts`

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

Bot 啟動時會：

- 使用 `setMyCommands` 註冊 Telegram 原生指令選單。
- 在啟動通知、`/start` 與 `/help` 顯示持續鍵盤。
- 只接受 `TELEGRAM_ALLOWED_CHAT_IDS` 內的 chat。

### Telegram 設定控制

Telegram 可修改：

- `channels`
- `max_concurrent_streams`

更新流程：

1. 驗證頻道名稱與數值。
2. 寫回 `config.yml`，保留其他 YAML 欄位與註解。
3. 立即更新 scheduler。
4. 移除頻道或降低上限時停止多餘 session。
5. 立即重新檢查新頻道。

規則：

- 頻道清單至少保留一個頻道。
- 頻道名稱只允許 1 至 25 字元的英數字與底線。
- 頻道名稱不分大小寫去重。
- `max_concurrent_streams` 不可大於頻道數。
- 移除頻道後若上限過大，會自動降低。

Docker Compose 已將 `/app/config.yml` 改為可寫 bind mount；`storage-state.json` 仍為唯讀。

### 多頻道選擇

當開台頻道超過 `max_concurrent_streams`：

1. 依 `channels` 設定順序決定優先權。
2. 只為前 N 個正在直播的頻道建立 Page。
3. 其餘頻道仍由 Helix API 監控，但不建立觀看 session。
4. 高優先序頻道上線時，會取代最低優先序的 session。
5. 目前觀看頻道離線後，自動補上下一個仍在線的頻道。

### Telegram 多頻道截圖

最新修正已提交於 `7d92adc`：

- `/screenshot` 會依 active session 順序回傳所有觀看中頻道的 PNG。
- `/screenshot <channel>` 只回傳指定頻道。
- 每張圖片使用頻道名稱作為 filename 與 caption。
- 截圖只保存在記憶體，不寫入磁碟。
- 沒有 active session 時回覆提示。

## 測試與驗證

目前最後一次完整程式驗證：

```text
npm run lint                     通過
npm run build                    通過
npm test                         通過
git diff --check                 通過
```

Vitest：

- 19 個測試檔案
- 257 項測試通過

Playwright E2E：

- 13 項測試通過
- macOS managed sandbox 會阻擋 Chromium／Firefox Mach port，需在沙箱外執行。
- Docker image 內 13 項 E2E 也已通過。

Docker：

- Compose model verifier 通過。
- Docker smoke test 通過。
- Smoke 已驗證 build、image 內容、缺設定失敗、Compose up、SIGTERM、restart 與容器內 `config.yml` 可寫。

Telegram screenshot 修正後：

- Telegram Bot 單元測試 8／8 通過。
- 完整 Vitest 257／257 通過。
- lint 與 TypeScript build 通過。

## 實際執行狀態與資源觀察

2026-06-15 實際容器量測，當時有 2 個 `watch_started` session：

| 項目 | 單次觀察值 |
| --- | ---: |
| 容器 CPU | 約 95% |
| 容器記憶體 | 約 1.74 GiB |
| Node.js RSS | 約 154 MiB |
| Firefox 主程序 RSS | 約 611 MiB |
| Firefox Web Content RSS | 約 513–524 MiB／程序 |

結論：

- 目前已共用單一 Firefox 與 Browser Context。
- 每個實際觀看頻道仍需要一個完整 Twitch Page。
- 主要成本是直播下載、軟體影音解碼、Twitch React UI、播放器與 Page 資源。
- CPU、記憶體與網路用量會隨實際觀看 Page 數接近線性增加。
- Node.js scheduler、Telegram 與 Helix API 不是主要瓶頸。

## 跨平台最佳化實作

`optimize/deep-resource-optimization` 分支已依 `doc/optimization.md` 完成第一階段深度最佳化：

- Linux x86_64／ARM64。
- macOS Intel／Apple Silicon。
- Windows。
- Docker Engine、Docker Desktop、OrbStack 與相容 OCI runtime。
- 主機直接執行 Node.js／Playwright。

核心方案只使用 Node.js、Playwright 與標準 Web API，不依賴：

- Docker socket。
- Linux `/proc`、cgroup、systemd。
- macOS Instruments。
- Windows WMI。
- 特定 shell 指令。
- 特定 GPU、driver 或硬體解碼。

已完成：

1. 加入播放器最低畫質設定、安全降級與每 120 秒重新校正。
2. 支援 Twitch 新版 `role="menuitemradio"` 畫質選項，實頁已成功選到 `160p`。
3. 維持原本 `1280x720` viewport 以保留機器人截圖版面，僅自動靜音。
4. 提供 Playwright routing 圖片、字型與 tracking 阻擋開關；為保留機器人截圖，三者預設關閉。
5. 健康檢查改為 60 秒，獎勵檢查改為 30 秒。
6. 使用穩定 jitter 與自排程 `setTimeout` 錯開各 Page 的週期工作。
7. 移除完整 `body.textContent()` 健康掃描，避免大範圍 DOM 序列化。
8. 加入低頻率跨平台 runtime telemetry 與 JSONL 轉 CSV helper。

不採用：

- 停止影片或攔截 HLS media。
- 單一 Page 快速輪流切換頻道。
- 將 Docker resource limit 當成最佳化。
- 依賴平台特定硬體加速。
- 凍結或 background throttle Page。

2026-06-15 三個實際觀看 session 的單次比較：

| 項目 | 最佳化前 | 最佳化後 |
| --- | ---: | ---: |
| 容器 CPU | 約 167.9% | 約 130.2% |
| 容器記憶體 | 約 2.749 GiB | 約 2.075 GiB |
| viewport | 1280x720 | 1280x720 |
| 畫質 | Twitch 自動 | 160p |

最終設定維持 `1280x720`，圖片、字型與 tracking 阻擋皆關閉。三個頻道均出現 `stream_playback_optimized`、`watch_started` 與 `reward_claimed`；啟動時偶發略過的頻道也會在 120 秒定期校正時補套用 `160p`。這是短時間單次觀察，不取代 15 分鐘以上的正式 benchmark。

## 已知風險

1. Twitch 播放器 DOM 不是穩定公開 API，網站改版可能影響畫質控制。
2. 強制低畫質必須確認 Channel Points 仍正常累積。
3. 圖片／字型／tracking 阻擋需要逐項驗證，不可攔截 GraphQL、media、登入與觀看心跳。
4. `config.yml` 必須讓容器內 `pwuser` 可寫；正式部署不可使用世界可寫權限。
5. Firefox 在不同 OS、CPU 架構與 runtime 的影音解碼效能差異很大。
6. Telegram Bot token 具有管理能力，必須持續限制 allowed chat IDs。
7. `storage-state.json` 等同登入憑證，必須保持唯讀掛載與最小檔案權限。

## 下一步

目前最合理的後續工作順序：

1. 取得 1／2／3 個頻道各 15 分鐘的正式基準數據。
2. 實際連續觀看至少 2 小時，確認 Points、截圖與 page health。
3. 最終在 Linux、macOS、Windows CI 驗證主機模式；Docker smoke 集中於 Linux。

## 常用命令

程式驗證：

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```

Docker 驗證：

```bash
./scripts/docker-smoke.sh
docker compose build
docker compose up -d --force-recreate
docker compose ps
docker compose logs --tail=200 twitch-watchdog
```

資源觀察：

```bash
docker stats twitch-watchdog --no-stream
docker top twitch-watchdog -eo pid,ppid,rss,comm,args
```

停止服務：

```bash
docker compose stop
docker compose down
```

## 安全與部署

- 容器使用非 root `pwuser`。
- root filesystem 為唯讀。
- `/tmp` 使用 tmpfs。
- 啟用 `no-new-privileges`。
- 使用專案內 seccomp profile。
- `config.yml` 可寫，供 Telegram 持久化設定。
- `storage-state.json` 維持唯讀 bind mount。
- Firefox browser process crash 具有限次自動重啟與 backoff。
- 所有敏感資訊必須經環境變數或忽略檔案提供，不可進入 image、Git、log 或文件。
