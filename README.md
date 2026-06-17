# Twitch Watchdog

Twitch Watchdog 是可用 Docker 長時間執行的 Twitch 觀看輔助服務。它會透過 Twitch  API 檢查指定頻道是否開台，依照設定優先序開啟觀看頁面，並自動領取 Bonus Channel Points。

本專案不會自動登入 Twitch，也不會要求你提供 Twitch 密碼。你需要自行登入 Twitch 後匯出 Playwright `storageState`，並提供 Twitch Developer App 的 Client ID 與 Client Secret。

## 功能

- 監控多個 Twitch 頻道開台狀態。
- 依 `channels` 順序與 `max_concurrent_streams` 決定實際觀看頻道。
- 使用 Firefox 播放 Twitch直播。
- 自動領取 Bonus Channel Points。
- 預設將直播畫質維持在 `160p` 並靜音，降低長時間執行資源用量。
- 可選用 Telegram Bot 查詢狀態、管理頻道、暫停/恢復排程與取得截圖。

不支援 Twitch Drops 自動領取、自動輸入帳號密碼、多帳號批量管理、CAPTCHA 繞過、反偵測或規避平台限制。

## 前置需求

- Docker Engine 與 Docker Compose plugin。
- 一個 Twitch 帳號。
- Twitch Developer Console 建立的 App Client ID 與 Client Secret。
- 若要在本機匯出登入狀態：Node.js 24 以上與 npm 11。

正式容器使用 `mcr.microsoft.com/playwright:v1.60.0-noble`，搭配專案 Playwright `1.60.0`。

## 快速開始

建立設定檔與 storageState 目錄：

```bash
cp config.example.yml config.yml
cp .env.example .env
mkdir -p data/browser-state
chmod 700 data data/browser-state
```

編輯 `config.yml`：

```yaml
channels:
  - streamer_one
  - streamer_two

check_interval_seconds: 60
max_concurrent_streams: 1
headless: true
storage_state_path: /data/browser-state/storage-state.json
log_level: info

browser:
  stream_quality: 160p
  page_refresh_interval_seconds: 300
```

重點設定：

- `channels`：Twitch login name 清單，順序就是觀看優先序。
- `check_interval_seconds`：Twitch API 輪詢間隔，最小 30 秒。
- `max_concurrent_streams`：最大同時觀看數。
- `storage_state_path`：容器內 Playwright storageState 路徑。
- `browser.stream_quality`：預設 `160p`；設為 `auto` 可停用強制畫質。
- `browser.page_refresh_interval_seconds`：預設 300 秒，定時重整觀看頁並依頻道錯開；設為 `0` 可關閉。

## Twitch API 設定

到 Twitch Developer Console 建立應用程式，取得 Client ID 與 Client Secret。建議放在 `.env`：

```dotenv
TWITCH_CLIENT_ID=你的ClientID
TWITCH_CLIENT_SECRET=你的ClientSecret
```

服務會用 Client Credentials flow 自動取得 App Access Token，並在 token 無效、接近過期或 Helix API 回傳 HTTP 401 時重新取得。Token 只保存在程序記憶體，不會寫入 `.env`。

`TWITCH_ACCESS_TOKEN` 只作為沒有 Client Secret 時的手動備援。

## 匯出 Twitch 登入狀態

先安裝本機依賴與 Firefox：

```bash
npm ci
npx playwright install firefox
mkdir -p data/browser-state
chmod 700 data data/browser-state
```

開啟一次性瀏覽器並儲存登入狀態：

```bash
npx playwright codegen \
  --save-storage=data/browser-state/storage-state.json \
  https://www.twitch.tv/
```

在開啟的瀏覽器中手動登入 Twitch，確認登入完成後關閉視窗，然後限制檔案權限：

```bash
chmod 600 data/browser-state/storage-state.json
```

`storage-state.json` 等同 Twitch 登入憑證。不要提交 Git、放入 Docker image、上傳到 issue 或分享給他人。若懷疑外洩，請立即在 Twitch 登出所有裝置或撤銷 session，然後重新匯出。

## 啟動服務

啟動前確認必要檔案與環境變數：

```bash
test -r config.yml
test -r data/browser-state/storage-state.json
test -n "${TWITCH_CLIENT_ID:-}"
test -n "${TWITCH_CLIENT_SECRET:-}"
docker compose config
```

建置並啟動：

```bash
docker compose build
docker compose up -d
docker compose logs -f twitch-watchdog
```

常用操作：

```bash
docker compose restart twitch-watchdog
docker compose stop
docker compose down
```

Compose 會將 `config.yml` 以可寫 bind mount 掛載，供 Telegram 管理指令持久化設定；`data/browser-state` 仍為唯讀。`config.yml` 必須可由容器內的 `pwuser` 寫入，請使用擁有者或群組權限處理，不要用全域可寫權限部署正式服務。

## Telegram 管理

Telegram 整合使用 Bot API 長輪詢，不需要開放 HTTP port。

1. 在 Telegram 與 [@BotFather](https://t.me/BotFather) 對話，用 `/newbot` 建立 bot 並取得 token。
2. 對你的 bot 傳送任意訊息。
3. 使用 Telegram Bot API `getUpdates` 取得 `message.chat.id`。
4. 在 `.env` 設定：

```dotenv
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=你的BotToken
TELEGRAM_ALLOWED_CHAT_IDS=你的ChatID
```

多個 chat ID 以逗號分隔。只有清單內的 chat 可以查詢或控制服務。

支援指令：

- `/status`：服務、開台與觀看狀態。
- `/channels`：監控頻道與最近一次狀態。
- `/refresh`：顯示正在觀看頻道的播放器重整倒數。
- `/refresh_now`：立即重整所有觀看中頻道。
- `/refresh_now 頻道名稱`：立即重整指定觀看中頻道。
- `/config`：顯示目前頻道與最大同時觀看數。
- `/channel_add 頻道名稱`：新增監控頻道。
- `/channel_remove 頻道名稱`：移除監控頻道。
- `/channels_set 頻道一,頻道二`：取代完整頻道清單。
- `/max_streams 數量`：調整最大同時觀看數。
- `/check`：立即檢查 Twitch 狀態。
- `/pause`：暫停自動檢查。
- `/resume`：恢復自動檢查。
- `/screenshot`：回傳所有觀看中頻道截圖。
- `/screenshot 頻道名稱`：回傳指定觀看中頻道截圖。
- `/help`：顯示指令說明。

定時重整 Twitch 播放器時，bot 會向允許的 chat 傳送重整提醒。

Bot token 具有管理能力，不得提交 Git 或貼到任何公開位置。

## 安全與限制

- 僅能用於你自己擁有或獲授權使用的 Twitch 帳號。
- 本工具不保證任何特定使用方式符合平台規則。
- 不要把 Twitch 或其他不受信任網站內容視為可信輸入。
- Twitch DOM 與忠誠點數 selector 可能變更；找不到按鈕時服務會繼續觀看並等待後續檢查。

開發、測試、架構與 smoke test 請見 [README_DEV.md](README_DEV.md)。
