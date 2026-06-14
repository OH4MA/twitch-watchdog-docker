# Twitch Watchdog

Twitch Watchdog 是以 Node.js、TypeScript 與 Playwright 建立的長時間執行服務。它使用 Twitch Helix API 檢查頻道是否開台，依設定優先序建立觀看頁面，並在頁面出現忠誠點數按鈕時嘗試領取。

本專案不會自動登入。使用者必須自行提供 Twitch API token，以及在本機手動登入後匯出的 Playwright `storageState`。

## 前置需求

- Docker Engine 與 Docker Compose plugin。
- 若要在主機開發：Node.js 24 以上與 npm 11。
- 自己擁有或獲授權使用的 Twitch 帳號。

Production image 固定使用 `mcr.microsoft.com/playwright:v1.60.0-noble`，與專案的 Playwright `1.60.0` 一致。該官方映像使用 Node.js 24，符合本專案 `node >=24` 的要求。

## 建立設定

```bash
cp config.example.yml config.yml
mkdir -p data/browser-state
```

編輯 `config.yml`：

- `channels`：Twitch login name，順序即優先序，至少一個；範例提供兩個。
- `check_interval_seconds`：Helix 輪詢間隔，最小 30 秒。
- `max_concurrent_streams`：同時觀看數；大於頻道數時會降為頻道數。
- `headless`：Docker 通常保持 `true`。
- `storage_state_path`：容器內 storageState 路徑。
- `log_level`：`debug`、`info`、`warn` 或 `error`。
- `browser`：導覽、頁面健康檢查、領點輪詢與 browser crash 復原設定。
- `telegram`：Telegram Bot 開關與長輪詢 timeout；預設停用。

`${TWITCH_CLIENT_ID}` 與 `${TWITCH_ACCESS_TOKEN}` 由環境變數插值，不要把真實值寫入 `config.yml`。

## Telegram 通知與管理

Telegram 整合使用 Bot API 長輪詢。Server 不需要 GUI，也不需要開放 HTTP port；只要能以 HTTPS 連到 `api.telegram.org`，即可從手機或另一台設備操作。

1. 在 Telegram 與 [@BotFather](https://t.me/BotFather) 對話，用 `/newbot` 建立 bot 並取得 token。
2. 對你的 bot 傳送任意訊息。
3. 暫時啟動 bot 或使用 Telegram Bot API `getUpdates`，從回應中的 `message.chat.id` 取得 chat ID。群組 chat ID 通常是負數。
4. 將 token 與允許操作的 chat ID 設為環境變數：

```bash
export TELEGRAM_ENABLED=true
read -rsp 'Telegram Bot Token: ' TELEGRAM_BOT_TOKEN; echo
export TELEGRAM_BOT_TOKEN
export TELEGRAM_ALLOWED_CHAT_IDS='你的 chat ID'
```

多個 chat ID 以逗號分隔，例如 `42,-1001234567890`。只有清單內的 chat 可以查詢或控制服務；未授權訊息會被忽略。

支援的指令：

- `/status`：服務、開台與目前觀看狀態。
- `/channels`：監控頻道與最近一次狀態。
- `/check`：立即執行一次 Twitch 狀態檢查。
- `/pause`：暫停自動檢查，不會遠端停止容器。
- `/resume`：恢復自動檢查。
- `/help`：顯示指令說明。

通知包含服務啟停、頻道開台或離線、忠誠點數領取成功或失敗。Bot token 屬於管理憑證，不得提交 Git、寫入 image 或貼到日誌。

## Twitch API token

1. 在 [Twitch Developer Console](https://dev.twitch.tv/console/apps) 註冊應用程式並取得 Client ID 與 Client Secret。
2. 依 Twitch 官方的 [Client Credentials Grant Flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow) 取得 app access token。`Get Streams` 可使用 app access token，不需要使用者帳號 scope。
3. Client Secret 只用於向 Twitch 交換 token，不應寫入本專案、Compose、設定檔或 image。

可在終端機一次性執行：

```bash
export TWITCH_CLIENT_ID='你的 Client ID'
read -rsp 'Twitch Client Secret: ' TWITCH_CLIENT_SECRET; echo
curl -sS -X POST 'https://id.twitch.tv/oauth2/token' \
  --data-urlencode "client_id=${TWITCH_CLIENT_ID}" \
  --data-urlencode "client_secret=${TWITCH_CLIENT_SECRET}" \
  --data-urlencode 'grant_type=client_credentials'
unset TWITCH_CLIENT_SECRET
```

從回應取得 `access_token` 後：

```bash
read -rsp 'Twitch Access Token: ' TWITCH_ACCESS_TOKEN; echo
export TWITCH_ACCESS_TOKEN
```

Token 逾期或撤銷後需重新取得。不要把 token 貼到 issue、日誌或 shell script。

## 匯出 storageState

先安裝本機依賴與 Chromium：

```bash
npm ci
npx playwright install chromium
mkdir -p data/browser-state
chmod 700 data data/browser-state
```

使用 Playwright codegen 開啟一次性瀏覽器：

```bash
npx playwright codegen \
  --save-storage=data/browser-state/storage-state.json \
  https://www.twitch.tv/
```

在開啟的瀏覽器中手動登入 Twitch，確認登入完成後關閉視窗。此流程不會把 Twitch 帳號或密碼寫入專案，也沒有自動登入功能。

```bash
chmod 600 data/browser-state/storage-state.json
```

`storageState` 內含登入 cookie，等同帳號登入憑證：

- 不得提交 Git、放入 image、分享或上傳到 issue。
- 懷疑外洩時，立即在 Twitch 登出所有裝置或撤銷 session，然後重新匯出。
- Linux bind mount 若出現讀取權限錯誤，應讓檔案擁有者與容器內非 root 執行者相容；不要用世界可讀權限解決。

## Docker 執行

先確認必要檔案與環境變數已準備：

```bash
test -r config.yml
test -r data/browser-state/storage-state.json
test -n "${TWITCH_CLIENT_ID:-}"
test -n "${TWITCH_ACCESS_TOKEN:-}"
test "${TELEGRAM_ENABLED:-false}" = false -o -n "${TELEGRAM_BOT_TOKEN:-}"
test "${TELEGRAM_ENABLED:-false}" = false -o -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}"
docker compose config
```

建置並啟動：

```bash
docker compose build
docker compose up -d
docker compose logs -f twitch-watchdog
```

一般操作：

```bash
docker compose restart twitch-watchdog
docker compose stop
docker compose down
```

Compose 將 `config.yml` 與 `data/browser-state` 唯讀掛載，使用 1 GiB shared memory，並以 `unless-stopped` 自動重啟。容器使用非 root `pwuser`、唯讀 root filesystem、`no-new-privileges`，並透過專案根目錄的 `seccomp_profile.json` 啟用 Chromium sandbox；`init: true` 會轉送 SIGTERM 並回收子程序。

`seccomp_profile.json` 取自 Playwright `v1.60.0` 官方 Docker profile，必須與 `docker-compose.yml` 一起保留。若 Compose 回報找不到 profile，請從專案根目錄執行命令，不要以 `seccomp=unconfined` 或關閉 Chromium sandbox 規避錯誤。

不建議把 token 寫入 `.env`。若確實使用 Compose 自動載入的 `.env`，該檔已被 Git 與 Docker build context 排除，仍應設為 `chmod 600 .env` 並限制備份與分享。

## 結構化日誌

應用程式只輸出 JSON Lines 到 stdout/stderr，不寫固定 log file。可用：

```bash
docker compose logs --no-log-prefix twitch-watchdog
docker compose logs --no-log-prefix twitch-watchdog | jq -c 'select(.event == "reward_claimed")'
```

主要事件包含 `service_started`、`config_loaded`、`credential_checked`、`stream_online`、`stream_offline`、`watch_started`、`watch_stopped`、`reward_claimed`、`reward_claim_failed`、`browser_restarted`、`page_health_failed` 與 `service_stopped`。Telegram 輪詢、傳送失敗與未授權 chat 也會留下不含訊息內容的事件。日誌會遮罩 cookie、token、Authorization header 與 storageState 內容。

## 開發與測試

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:unit
npm run test:integration
npm run test:e2e
```

本機執行服務：

```bash
CONFIG_PATH="$PWD/config.yml" npm start
```

Docker smoke test：

```bash
./scripts/docker-smoke.sh
```

Smoke test 會建置測試與正式 targets，檢查 image 不含敏感檔案，驗證缺設定的失敗訊息，並以 `network_mode: none` 的測試 override 實際執行 Chromium sandbox、Compose up、SIGTERM 與 restart。所有憑證均為假值，測試不會連線 Twitch API 或網站。

## 安全、合規與限制

- 僅能用於自己擁有或獲授權使用的 Twitch 帳號。
- 使用者需自行確認 [Twitch Terms of Service](https://www.twitch.tv/p/en/legal/terms-of-service/) 與社群規範；本工具不保證特定使用方式符合平台規則。
- 不支援自動輸入帳號密碼、多帳號管理、CAPTCHA 繞過、反偵測、fingerprint 偽裝、規避平台限制或大量擴張觀看數。
- 不提供 Web UI、健康檢查端點或自動 token 更新；管理介面由選用的 Telegram Bot 提供。
- Twitch DOM 與忠誠點數 selector 可能變更；找不到按鈕不視為服務錯誤，selector 需隨平台調整。
- 不要把 Twitch 或其他不受信任網站的內容視為可信輸入。Playwright 官方也提醒其 Docker image 主要供測試與開發使用；部署者應自行評估瀏覽第三方網站的隔離需求。
