# Twitch 自動掛台與忠誠點數領取 Docker 容器詳細設計文件

## 1. 文件目的與設計結論

本文件依據 [`doc/proposal.md`](proposal.md) 產生，描述初版系統的模組切分、資料流程、設定格式、錯誤處理、測試策略與 Docker 部署設計。

初版設計結論如下：

- 技術棧：**Node.js + TypeScript + Playwright**。
- 開台狀態判斷：使用 **Twitch 官方 API**。
- 登入狀態匯入：使用 **Playwright `storageState` JSON**。
- 預設最大同時掛台數：`3`。
- 測試策略：包含單元測試、模組整合測試，以及 **mock Twitch 頁面** 測試瀏覽器自動化行為。
- 不實作自動登入、多帳號管理、反偵測、繞過驗證或大量擴張觀看數功能。

## 2. 系統範圍

### 2.1 初版包含

1. 讀取 YAML 設定檔與環境變數覆寫。
2. 驗證 Twitch API 憑證、頻道清單與 Playwright storage state 檔案。
3. 定期透過 Twitch API 查詢多個頻道直播狀態。
4. 依設定順序與 `max_concurrent_streams` 選出要掛台的直播頻道。
5. 使用 Playwright 開啟 Twitch 頻道頁面並維持觀看狀態。
6. 在頁面中偵測並點擊忠誠點數獎勵按鈕。
7. 記錄服務狀態、頻道狀態變更、掛台開始/停止、領點結果與錯誤。
8. 提供 Dockerfile、docker-compose.yml、config.example.yml 與登入狀態匯入說明。
9. 提供 mock Twitch 頁面與測試架構。
10. 可選擇透過 Telegram Bot 接收狀態通知與執行受限管理指令。

### 2.2 初版不包含

1. 自動輸入 Twitch 帳號密碼登入。
2. 多帳號管理。
3. Web UI。
4. Discord、Email 等其他通知系統。
5. 反偵測、繞過驗證、規避平台限制、批量帳號或大量觀看數用途。
6. 跨節點分散式掛台。

## 3. 架構總覽

### 3.1 邏輯架構

系統拆分為下列可獨立測試模組：

```text
┌────────────────────────────────────────────────────────────┐
│                         App Runner                         │
│                啟動、生命週期、錯誤邊界、關閉流程              │
└───────────────────────┬────────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────────┐
│                      Config Module                         │
│                 讀取、合併、驗證、預設值套用                  │
└───────────────────────┬────────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────────┐
│                   Credential Module                        │
│       Twitch API token 設定檢查、storageState 檔案檢查         │
└───────────────────────┬────────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────────┐
│                    Watchdog Scheduler                      │
│             定期輪詢、狀態比較、掛台任務協調                  │
└───────────────┬───────────────────────────────┬────────────┘
                │                               │
┌───────────────▼──────────────┐   ┌────────────▼─────────────┐
│      Twitch API Module       │   │    Stream Selection       │
│  查詢使用者 ID、直播狀態、限流  │   │  依優先序與併發限制選台     │
└───────────────┬──────────────┘   └────────────┬─────────────┘
                │                               │
                └───────────────┬───────────────┘
                                │
┌───────────────────────────────▼────────────────────────────┐
│                    Browser Manager                         │
│      啟動/關閉 browser context、載入 storageState、復原崩潰     │
└───────────────────────────────┬────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────┐
│                    Channel Session                         │
│         每個頻道一個頁面：導覽、健康檢查、重載、停止             │
└───────────────────────────────┬────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────┐
│                    Reward Claimer                          │
│          偵測忠誠點數按鈕、點擊、回報成功/失敗/未出現            │
└───────────────────────────────┬────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────┐
│                  Logging & Observability                   │
│              結構化日誌、敏感資料遮罩、事件紀錄                 │
└────────────────────────────────────────────────────────────┘
```

### 3.2 執行流程

1. App Runner 啟動。
2. Config Module 讀取 `CONFIG_PATH` 指定的設定檔，套用預設值與環境變數覆寫。
3. Credential Module 檢查：
   - Twitch API 設定是否存在。
   - `storage_state_path` 是否存在且可讀。
   - storage state 是否為合法 JSON。
4. Browser Manager 啟動 Playwright browser 與 browser context。
5. Watchdog Scheduler 依 `check_interval_seconds` 週期執行：
   1. Twitch API Module 查詢所有設定頻道的直播狀態。
   2. Stream Selection 依設定順序與 `max_concurrent_streams` 選出 active set。
   3. 對 active set 中尚未掛台的頻道建立 Channel Session。
   4. 對不在 active set 或已離線的頻道停止 Channel Session。
6. 每個 Channel Session 週期性執行頁面健康檢查與 Reward Claimer。
7. 程式收到 SIGTERM/SIGINT 時，依序停止 scheduler、關閉頁面、關閉 browser，最後結束程序。

## 4. 設定設計

### 4.1 設定檔格式

初版使用 YAML，檔案預設路徑為 `/app/config.yml`，可由 `CONFIG_PATH` 覆寫。

```yaml
channels:
  - streamer_one
  - streamer_two
  - streamer_three

check_interval_seconds: 60
max_concurrent_streams: 3
headless: true
storage_state_path: /data/browser-state/storage-state.json
log_level: info

# Twitch 官方 API 設定。也可用環境變數覆寫。
twitch_api:
  client_id: ${TWITCH_CLIENT_ID}
  access_token: ${TWITCH_ACCESS_TOKEN}

browser:
  navigation_timeout_ms: 30000
  page_health_check_interval_seconds: 30
  reward_check_interval_seconds: 15
  restart_on_crash: true
```

### 4.2 設定欄位

| 欄位 | 必填 | 預設值 | 說明 |
|---|---:|---:|---|
| `channels` | 是 | 無 | Twitch 頻道 login name 清單。順序代表優先序。 |
| `check_interval_seconds` | 否 | `60` | 查詢 Twitch API 的輪詢間隔。 |
| `max_concurrent_streams` | 否 | `3` | 最大同時掛台頁面數。 |
| `headless` | 否 | `true` | 是否使用無頭瀏覽器。 |
| `storage_state_path` | 否 | `/data/browser-state/storage-state.json` | Playwright storageState JSON 路徑。 |
| `log_level` | 否 | `info` | `debug`、`info`、`warn`、`error`。 |
| `twitch_api.client_id` | 是 | 無 | Twitch API Client ID；可由 `TWITCH_CLIENT_ID` 提供。 |
| `twitch_api.access_token` | 是 | 無 | Twitch API access token；可由 `TWITCH_ACCESS_TOKEN` 提供。 |
| `browser.navigation_timeout_ms` | 否 | `30000` | 頁面導覽逾時。 |
| `browser.page_health_check_interval_seconds` | 否 | `30` | 頁面健康檢查間隔。 |
| `browser.reward_check_interval_seconds` | 否 | `15` | 忠誠點數按鈕偵測間隔。 |
| `browser.restart_on_crash` | 否 | `true` | browser/page crash 後是否嘗試重啟。 |

### 4.3 環境變數覆寫

| 環境變數 | 對應設定 |
|---|---|
| `CONFIG_PATH` | 設定檔路徑 |
| `TWITCH_CLIENT_ID` | `twitch_api.client_id` |
| `TWITCH_ACCESS_TOKEN` | `twitch_api.access_token` |
| `LOG_LEVEL` | `log_level` |
| `HEADLESS` | `headless` |

環境變數優先於設定檔，但不得將 token 原文輸出到日誌。

### 4.4 設定驗證規則

Config Module 必須執行下列驗證：

- `channels` 必須為非空陣列。
- 頻道名稱必須符合 Twitch login name 常見格式：英數字與底線，長度 1 到 25。
- `check_interval_seconds` 必須大於等於 30，避免過度頻繁請求 Twitch。
- `max_concurrent_streams` 必須大於等於 1，且不得大於 `channels.length`；若大於頻道數，可降為頻道數並記錄 debug 日誌。
- `log_level` 必須是允許值。
- Twitch API Client ID 與 access token 不可為空。
- `storage_state_path` 必須可讀，且內容為合法 JSON。

## 5. 模組詳細設計

## 5.1 App Runner

### 職責

- 程式入口點。
- 初始化 Config、Logger、Credential、Browser、Scheduler。
- 管理啟動與關閉流程。
- 捕捉未處理例外並輸出安全日誌。

### 介面

```ts
type AppRunner = {
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
};
```

### 行為

- 啟動成功後輸出 `service_started`。
- 若設定或憑證驗證失敗，輸出清楚錯誤並以非 0 exit code 結束。
- 收到 SIGTERM/SIGINT 時：
  1. 停止 Watchdog Scheduler。
  2. 停止所有 Channel Session。
  3. 關閉 Browser Manager。
  4. flush logger。

### 可測試性

- 以 mock ConfigLoader、Scheduler、BrowserManager 驗證啟停順序。
- 模擬初始化失敗，確認 stop 不會重複釋放資源。

## 5.2 Config Module

### 職責

- 讀取 YAML 設定檔。
- 合併預設值與環境變數。
- 驗證設定型別與範圍。
- 回傳不可變設定物件。

### 介面

```ts
type AppConfig = {
  channels: string[];
  checkIntervalSeconds: number;
  maxConcurrentStreams: number;
  headless: boolean;
  storageStatePath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  twitchApi: {
    clientId: string;
    accessToken: string;
  };
  browser: {
    navigationTimeoutMs: number;
    pageHealthCheckIntervalSeconds: number;
    rewardCheckIntervalSeconds: number;
    restartOnCrash: boolean;
  };
};

interface ConfigLoader {
  load(path: string, env: NodeJS.ProcessEnv): Promise<AppConfig>;
}
```

### 錯誤

- `ConfigFileNotFoundError`
- `ConfigParseError`
- `ConfigValidationError`

錯誤訊息可包含欄位名稱，但不得包含 Twitch access token。

### 可測試性

- 使用 fixture 測試合法設定、缺少必填欄位、型別錯誤、環境變數覆寫。
- 驗證輸出設定已套用預設值。

## 5.3 Credential Module

### 職責

- 檢查 Playwright storageState JSON 是否存在、可讀、格式合法。
- 檢查 Twitch API 憑證是否存在。
- 遮罩敏感欄位供日誌使用。

### storageState 格式

使用 Playwright 原生格式：

```json
{
  "cookies": [
    {
      "name": "auth-token",
      "value": "***",
      "domain": ".twitch.tv",
      "path": "/",
      "expires": 1893456000,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": []
}
```

實際檔案中的 cookie value 不可被日誌輸出。

### 介面

```ts
interface CredentialValidator {
  validate(config: AppConfig): Promise<CredentialValidationResult>;
}

type CredentialValidationResult = {
  storageStatePath: string;
  hasCookies: boolean;
  twitchApiConfigured: boolean;
};
```

### 行為

- 若 storageState 不存在：回報「找不到登入狀態檔案，請重新匯出 Playwright storageState 並掛載到容器」。
- 若 JSON 格式錯誤：回報「登入狀態檔案格式錯誤」。
- 若 cookies 為空：可啟動但輸出 warn，因為部分登入狀態可能在 origins 中；若後續頁面判定未登入再回報錯誤。
- 不驗證 token 是否有效；Twitch API Module 會在第一次請求時處理 401/403。

### 可測試性

- 使用臨時檔案測試不存在、不可讀、格式錯誤、合法 JSON。
- 驗證錯誤與日誌不包含 cookie value 或 token。

## 5.4 Twitch API Module

### 職責

- 使用 Twitch 官方 API 查詢頻道是否正在直播。
- 封裝 HTTP 請求、錯誤處理、限流回應與資料轉換。
- 將 API 回應轉為內部 `ChannelLiveStatus`。

### API 使用

初版使用 Twitch Helix `GET /helix/streams?user_login=...`。

- Header：
  - `Client-Id: <client_id>`
  - `Authorization: Bearer <access_token>`
- 可在單次請求中帶多個 `user_login` 參數。
- 回傳 `data` 中存在的頻道視為 live；不在 `data` 中的頻道視為 offline。

### 介面

```ts
type ChannelLiveStatus = {
  channel: string;
  isLive: boolean;
  streamId?: string;
  title?: string;
  startedAt?: string;
  viewerCount?: number;
  checkedAt: string;
};

interface LiveStatusProvider {
  getLiveStatuses(channels: string[]): Promise<ChannelLiveStatus[]>;
}
```

### 錯誤處理

| API 狀態 | 行為 |
|---|---|
| 200 | 正常轉換狀態。 |
| 401/403 | 記錄 `twitch_api_auth_failed`，暫停本輪狀態更新，提示檢查 token。 |
| 429 | 記錄限流，依回應 header 或退避策略延後下一輪。 |
| 5xx | 記錄 warn/error，本輪保持既有 session，不因暫時 API 失敗關閉掛台。 |
| 網路錯誤 | 同 5xx。 |

### 限流策略

- 正常情況依 `check_interval_seconds` 輪詢。
- 若收到 429：
  - 優先使用 Twitch 回應中的 reset 資訊。
  - 若無法解析，下一輪延後到 `check_interval_seconds * 2`，上限 5 分鐘。
- 限流狀態解除後恢復正常輪詢。

### 可測試性

- 使用 mock HTTP client 測試 live/offline 轉換。
- 測試 401/403/429/5xx 行為。
- 驗證 token 不出現在錯誤訊息中。

## 5.5 Watchdog Scheduler

### 職責

- 定期觸發 Twitch API 狀態查詢。
- 比較上一輪與本輪頻道狀態。
- 呼叫 Stream Selection 選出 active set。
- 建立或停止 Channel Session。
- 防止輪詢重疊。

### 介面

```ts
interface WatchdogScheduler {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
}
```

### 行為

- `runOnce()` 若尚未完成，下一次 tick 不得重入，應記錄 `scheduler_tick_skipped`。
- Twitch API 暫時失敗時，不立即停止現有 Channel Session，避免因短暫 API 問題中斷掛台。
- 只有在明確取得某頻道 `isLive=false` 時，才停止該頻道 Session。
- 每次 active set 變化時輸出狀態變更日誌。

### 可測試性

- mock LiveStatusProvider 與 SessionManager。
- 驗證 live → start session、offline → stop session。
- 驗證 API 失敗時不停止既有 session。
- 驗證 tick 不重入。

## 5.6 Stream Selection Module

### 職責

- 根據設定順序、直播狀態與 `max_concurrent_streams` 決定本輪應掛台頻道。
- 維持簡單、可預測、可測試的優先序策略。

### 規則

1. 依 `channels` 設定順序排序。
2. 過濾 `isLive=true` 的頻道。
3. 取前 `max_concurrent_streams` 個頻道作為 active set。
4. 若正在掛台的低優先序頻道被高優先序直播頻道擠出，Scheduler 應停止低優先序 Session 並啟動高優先序 Session。

### 介面

```ts
interface StreamSelector {
  selectActiveChannels(input: {
    configuredChannels: string[];
    liveStatuses: ChannelLiveStatus[];
    maxConcurrentStreams: number;
  }): string[];
}
```

### 可測試性

- 純函式測試即可。
- 測試無人開台、少於上限、等於上限、超過上限、API 回傳順序不同於設定順序等情境。

## 5.7 Browser Manager

### 職責

- 啟動 Playwright Chromium。
- 使用 `storageState` 建立 browser context。
- 管理所有 Channel Session 的 browser page。
- 監聽 browser/page crash 並提供重啟能力。

### 介面

```ts
interface BrowserManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  createPage(channel: string): Promise<Page>;
  closePage(channel: string): Promise<void>;
  restart(): Promise<void>;
}
```

### Playwright 啟動設定

- 使用 Playwright 官方 Chromium。
- Docker 中使用 Playwright 官方 base image 或自行安裝必要依賴。
- `headless` 由設定控制。
- context 建立時載入：

```ts
await browser.newContext({
  storageState: config.storageStatePath,
  viewport: { width: 1280, height: 720 },
});
```

### Crash 復原

- 若單一 page crash：關閉該 session 並由 Scheduler 在下一輪重建。
- 若 browser crash：
  1. 標記所有 session 為需要重建。
  2. 嘗試重啟 browser。
  3. 重啟成功後，由 Scheduler 依 live status 重建 active sessions。
- 重啟失敗需記錄 error，並在下一輪繼續嘗試；避免快速無限重啟。

### 可測試性

- 使用 Playwright mock 或 integration fixture 測試 context 建立參數。
- 使用 mock Browser/Page 測試 create/close/restart 流程。
- 端到端測試可使用 mock Twitch 頁面。

## 5.8 Channel Session

### 職責

- 管理單一 Twitch 頻道頁面的生命週期。
- 導覽至頻道 URL。
- 檢查頁面是否健康。
- 呼叫 Reward Claimer。
- 在停止時釋放頁面資源。

### 介面

```ts
type ChannelSessionState =
  | 'starting'
  | 'watching'
  | 'recovering'
  | 'stopping'
  | 'stopped'
  | 'failed';

interface ChannelSession {
  channel: string;
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
  checkHealth(): Promise<ChannelHealthResult>;
  tickRewardClaim(): Promise<RewardClaimResult>;
}
```

### 頁面 URL

```text
https://www.twitch.tv/<channel>
```

### 健康檢查

初版健康檢查使用保守判斷，不實作反偵測：

- 頁面 URL 是否仍在目標 channel。
- 是否出現 Twitch 登入提示或明顯未登入狀態。
- 是否出現播放器容器或直播內容區域。
- 是否出現錯誤頁面、網路錯誤或 page crash。

若健康檢查失敗：

1. 第一次嘗試 `page.reload()`。
2. 連續失敗超過設定次數後關閉 page，讓 Scheduler 重建。
3. 所有失敗需記錄，但不得包含 cookies 或 token。

### 可測試性

- 使用 mock page 測試 start/stop/checkHealth。
- 使用 mock Twitch 頁面測試：
  - 正常直播頁。
  - 未登入頁。
  - 錯誤頁。
  - 頁面 reload 後恢復。

## 5.9 Reward Claimer

### 職責

- 在 Channel Session 的 page 中尋找忠誠點數獎勵按鈕。
- 當按鈕存在且可點擊時點擊。
- 回報成功、未找到、點擊失敗。

### 定位策略

忠誠點數按鈕在不同語系下文字可能不同，因此初版採多層定位策略：

1. 優先使用 Twitch 可能穩定的 test id 或 aria label。範例：
   - `[data-test-selector="community-points-summary"]`
   - `[data-test-selector="community-points-claim-button"]`
2. 若 test id 不穩定，使用按鈕區域與可點擊元素結構定位。
3. 文件註明 Twitch 前端 DOM 可能變動，定位器需透過測試與日誌維護。
4. 不使用語系文字作為唯一定位條件；可作為輔助 fallback。

### 介面

```ts
type RewardClaimResult =
  | { status: 'claimed'; channel: string; claimedAt: string }
  | { status: 'not_found'; channel: string; checkedAt: string }
  | { status: 'click_failed'; channel: string; checkedAt: string; error: string };

interface RewardClaimer {
  claimIfAvailable(page: Page, channel: string): Promise<RewardClaimResult>;
}
```

### 行為

- 找不到按鈕不是錯誤，回傳 `not_found`，debug 層級即可。
- 找到但不可見或 disabled 時，視為 `not_found` 或 debug 事件。
- 點擊成功後輸出 info：`reward_claimed`，包含 channel 與時間。
- 點擊失敗輸出 warn：`reward_claim_failed`，後續輪詢會再試。
- 避免因快速輪詢重複點擊：一次成功點擊後可對同一 channel 設定短暫冷卻，例如 60 秒。

### 可測試性

- 使用 mock page 測試不同 selector。
- 使用 mock Twitch 頁面測試按鈕存在、按鈕不存在、按鈕 disabled、點擊拋錯。
- 驗證 click failed 不會讓 Channel Session 停止。

## 5.10 Session Manager

### 職責

- 維護 `channel -> ChannelSession` 對照表。
- 避免同一頻道重複建立 session。
- 協調 start/stop。

### 介面

```ts
interface SessionManager {
  reconcile(activeChannels: string[]): Promise<void>;
  stopAll(reason: string): Promise<void>;
  getActiveChannels(): string[];
}
```

### 行為

- `reconcile(activeChannels)`：
  - activeChannels 中不存在於目前 sessions 的頻道：建立並啟動。
  - 目前 sessions 中不在 activeChannels 的頻道：停止並移除。
  - 已存在的頻道：保持。
- 若 start session 失敗：記錄 error，不影響其他頻道。
- 若 stop session 失敗：記錄 warn，仍從 registry 移除或標記待清理，避免卡死。

### 可測試性

- mock ChannelSessionFactory。
- 測試 reconcile 的新增、移除、保持、失敗隔離。

## 5.11 Logging & Observability

### 職責

- 提供結構化日誌。
- 根據 `log_level` 控制輸出。
- 遮罩敏感資訊。
- 讓 Docker logs 可直接追蹤狀態。

### 日誌格式

建議 JSON line：

```json
{"level":"info","event":"stream_started","channel":"streamer_one","time":"2026-06-14T12:00:00.000Z"}
```

### 必要事件

| event | level | 說明 |
|---|---|---|
| `service_started` | info | 服務啟動成功。 |
| `config_loaded` | info | 設定載入成功。 |
| `config_error` | error | 設定載入或驗證失敗。 |
| `credential_checked` | info | 登入狀態檔案檢查完成。 |
| `twitch_api_auth_failed` | error | Twitch API token 無效或權限不足。 |
| `stream_online` | info | 頻道由 offline 變為 online。 |
| `stream_offline` | info | 頻道由 online 變為 offline。 |
| `watch_started` | info | 開始掛台。 |
| `watch_stopped` | info | 停止掛台。 |
| `reward_claimed` | info | 忠誠點數領取成功。 |
| `reward_claim_failed` | warn | 忠誠點數點擊失敗。 |
| `browser_restarted` | warn | Browser 被重啟。 |
| `page_health_failed` | warn | 頁面健康檢查失敗。 |
| `service_stopped` | info | 服務停止。 |

### 敏感資訊遮罩

Logger 必須遮罩：

- Cookie value。
- OAuth token。
- Twitch access token。
- Authorization header。
- storageState 原始內容。

### 可測試性

- 測試 log level 過濾。
- 測試敏感字串遮罩。
- 測試必要事件欄位完整。

## 6. 資料模型

### 6.1 Channel 狀態

```ts
type ChannelRuntimeState = {
  channel: string;
  priority: number;
  liveStatus: ChannelLiveStatus;
  sessionState?: ChannelSessionState;
  lastStatusChangeAt?: string;
  lastRewardClaimAt?: string;
  lastError?: string;
};
```

### 6.2 內部事件

```ts
type WatchdogEvent =
  | { type: 'STREAM_ONLINE'; channel: string; at: string }
  | { type: 'STREAM_OFFLINE'; channel: string; at: string }
  | { type: 'WATCH_STARTED'; channel: string; at: string }
  | { type: 'WATCH_STOPPED'; channel: string; at: string; reason: string }
  | { type: 'REWARD_CLAIMED'; channel: string; at: string }
  | { type: 'ERROR'; scope: string; channel?: string; error: string; at: string };
```

初版事件僅輸出到日誌，不需要持久化資料庫。

## 7. 錯誤處理策略

| 錯誤類型 | 模組 | 行為 |
|---|---|---|
| 設定檔不存在 | Config | 啟動失敗，非 0 exit。 |
| 設定格式錯誤 | Config | 啟動失敗，指出欄位。 |
| storageState 不存在 | Credential | 啟動失敗，提示重新匯出與掛載。 |
| Twitch API token 無效 | Twitch API | 記錄 error，保留既有 sessions，下一輪重試。 |
| Twitch API 暫時錯誤 | Twitch API | 記錄 warn，保留既有 sessions。 |
| 頻道 offline | Scheduler | 停止該頻道 session。 |
| page crash | Browser/Session | 關閉 page，下一輪重建。 |
| browser crash | Browser | 嘗試重啟 browser，標記 sessions 重建。 |
| 找不到忠誠點數按鈕 | Reward | 非錯誤，debug 或不輸出。 |
| 點擊忠誠點數失敗 | Reward | warn，後續再試。 |

## 8. Docker 設計

### 8.1 Dockerfile

建議使用 Playwright 官方 Node.js image，例如：

```Dockerfile
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist
COPY config.example.yml ./config.example.yml

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config.yml

CMD ["node", "dist/index.js"]
```

實際版本應與 `package.json` 中 Playwright 版本對齊。

### 8.2 docker-compose.yml

```yaml
services:
  twitch-watchdog:
    build: .
    container_name: twitch-watchdog
    restart: unless-stopped
    environment:
      CONFIG_PATH: /app/config.yml
      TWITCH_CLIENT_ID: ${TWITCH_CLIENT_ID}
      TWITCH_ACCESS_TOKEN: ${TWITCH_ACCESS_TOKEN}
    volumes:
      - ./config.yml:/app/config.yml:ro
      - ./data/browser-state:/data/browser-state:ro
    shm_size: "1gb"
```

### 8.3 Volume

| Host path | Container path | 模式 | 用途 |
|---|---|---|---|
| `./config.yml` | `/app/config.yml` | ro | 設定檔。 |
| `./data/browser-state` | `/data/browser-state` | ro | Playwright storageState JSON。 |

若未來需要保存瀏覽器 cache，可另加可寫 volume，但初版不依賴 cache。

### 8.4 stdout/stderr

- 所有應用程式日誌輸出到 stdout/stderr。
- 不寫入容器內固定 log file。
- Docker logs 即可查看狀態。

## 9. Playwright storageState 匯入流程

### 9.1 使用者流程

1. 使用者在本機以 Playwright 或瀏覽器輔助腳本登入 Twitch。
2. 匯出 storage state 到：

```text
./data/browser-state/storage-state.json
```

3. 以 Docker volume 掛載到容器：

```yaml
- ./data/browser-state:/data/browser-state:ro
```

4. 設定：

```yaml
storage_state_path: /data/browser-state/storage-state.json
```

### 9.2 文件警示

使用文件必須明確提醒：

- storageState 內含登入憑證，等同於帳號登入狀態。
- 請勿提交到 git。
- 請勿分享給他人。
- 建議設定檔案權限，只允許使用者本人讀取。
- 若懷疑外洩，應立即登出 Twitch 所有裝置或撤銷 session。

## 10. 測試設計

### 10.1 測試層級

| 層級 | 目的 | 工具 |
|---|---|---|
| 單元測試 | 驗證純邏輯與錯誤處理 | Vitest 或 Jest |
| 模組整合測試 | 驗證模組協作與 mock HTTP | Vitest/Jest + mock HTTP server |
| Playwright 整合測試 | 驗證頁面自動化與 reward click | Playwright test + mock Twitch pages |
| Docker smoke test | 驗證容器可啟動、讀取設定與 storageState | docker compose |

### 10.2 Mock Twitch 頁面

建立測試用本機頁面或測試 server，提供下列頁面狀態：

1. `live.html`：模擬直播頁與播放器容器。
2. `offline.html`：模擬離線頁。
3. `reward-available.html`：包含可點擊忠誠點數按鈕。
4. `reward-disabled.html`：包含 disabled 或不可見按鈕。
5. `login-required.html`：模擬登入失效。
6. `error.html`：模擬播放器錯誤或頁面錯誤。

Reward Claimer 測試應驗證：

- 按鈕存在時會點擊。
- 按鈕不存在不視為錯誤。
- 點擊失敗會回傳 `click_failed`。
- 不同語系文字不影響 primary selector。

### 10.3 Twitch API 測試

使用 mock HTTP client 或本機 mock server 測試：

- 多頻道查詢回傳部分 live。
- 所有頻道 offline。
- API 回傳 401/403。
- API 回傳 429。
- API 回傳 5xx 或 timeout。

### 10.4 Scheduler 測試

- live set 未變：不重建 session。
- 新頻道 live：啟動 session。
- 頻道 offline：停止 session。
- 高優先序頻道上線且超出併發上限：停止低優先序，啟動高優先序。
- API 失敗：不停止既有 session。
- tick 尚未完成時下一次 tick 被略過。

### 10.5 驗收測試對應

| 需求驗收標準 | 測試方式 |
|---|---|
| Dockerfile 可成功建置 | CI 或本機 `docker build` smoke test。 |
| docker-compose 可啟動服務 | `docker compose up` smoke test。 |
| 可指定至少兩個頻道 | Config unit test + compose example。 |
| 可讀取登入狀態 | Credential test + startup integration test。 |
| 開台時自動開頁掛台 | API mock + SessionManager integration test。 |
| 忠誠點數按鈕出現時自動點擊 | Playwright mock page test。 |
| 領取與狀態變化有日誌 | Logger assertion test。 |
| 容器重啟後恢復運作 | Docker smoke test，重啟後重新讀取設定與 storageState。 |

## 11. 安全與合規設計

### 11.1 敏感資料原則

- 不接受 Twitch 帳號密碼作為設定。
- 不將 cookie、token 或 storageState 寫入日誌。
- 不將 storageState 放入 Docker image。
- `config.example.yml` 不提供真實 token。
- `.gitignore` 應包含：

```gitignore
data/browser-state/
*.storage-state.json
storage-state.json
.env
```

### 11.2 功能限制

系統不得加入以下功能：

- 自動解 CAPTCHA。
- 規避 Twitch 自動化偵測。
- 修改瀏覽器 fingerprint 以隱藏自動化。
- 多帳號批量登入。
- 大量頻道或大量帳號擴張觀看數。

### 11.3 使用者文件提醒

README 或使用文件需包含：

- 本工具僅供使用者自己擁有或授權使用的 Twitch 帳號。
- 使用者需自行確認 Twitch 服務條款與社群規範。
- 匯出的登入狀態等同登入憑證，外洩可能造成帳號風險。

## 12. 建議專案結構

```text
.
├── Dockerfile
├── docker-compose.yml
├── config.example.yml
├── package.json
├── tsconfig.json
├── src
│   ├── index.ts
│   ├── app
│   │   └── AppRunner.ts
│   ├── config
│   │   ├── ConfigLoader.ts
│   │   └── ConfigSchema.ts
│   ├── credentials
│   │   └── CredentialValidator.ts
│   ├── twitch
│   │   ├── TwitchApiClient.ts
│   │   └── LiveStatusProvider.ts
│   ├── scheduler
│   │   ├── WatchdogScheduler.ts
│   │   └── StreamSelector.ts
│   ├── browser
│   │   ├── BrowserManager.ts
│   │   ├── ChannelSession.ts
│   │   └── RewardClaimer.ts
│   ├── sessions
│   │   └── SessionManager.ts
│   ├── logging
│   │   └── Logger.ts
│   └── types
│       └── index.ts
├── test
│   ├── fixtures
│   ├── mock-pages
│   ├── unit
│   ├── integration
│   └── e2e
└── doc
    ├── proposal.md
    └── detailed-design.md
```

## 13. 實作順序建議

1. 建立 Node.js + TypeScript 專案骨架。
2. 實作 Config Module 與 Logger。
3. 實作 Credential Module。
4. 實作 Twitch API Module 與 mock HTTP 測試。
5. 實作 Stream Selection Module。
6. 實作 Session Manager 與 Watchdog Scheduler。
7. 實作 Browser Manager。
8. 實作 Channel Session 與 Reward Claimer。
9. 建立 mock Twitch 頁面與 Playwright 整合測試。
10. 建立 Dockerfile、docker-compose.yml、config.example.yml。
11. 補齊 README：設定、storageState 匯入、安全提醒、執行方式。
12. 執行 Docker smoke test 與驗收測試。

## 14. 未來擴充點

### 14.1 LiveStatusProvider 可替換

雖初版採 Twitch 官方 API，但 `LiveStatusProvider` 介面可保留替換彈性：

- Twitch API provider。
- 頁面檢查 provider。
- 第三方公開資訊 provider。

替換時不應影響 Scheduler、SessionManager 或 Browser 模組。

### 14.2 通知系統

目前提供可選的 Telegram Bot 長輪詢整合，支援服務、直播狀態與領點通知，以及狀態查詢、立即檢查、暫停與恢復。未來可將同一事件契約擴充至 Discord 或 Email。

### 14.3 健康檢查端點

未來可加入 `/healthz` HTTP server，回報：

- process 是否存活。
- browser 是否啟動。
- scheduler 最近一次成功 tick 時間。
- active sessions 數量。

初版不實作，但日誌需保留足夠資訊供 Docker logs 追蹤。

## 15. 需求追蹤矩陣

| 需求 | 設計對應 |
|---|---|
| 多頻道清單 | Config Module、Stream Selection。 |
| 設定檔或環境變數 | Config Module、環境變數覆寫。 |
| 定期檢查開台 | Watchdog Scheduler、Twitch API Module。 |
| 檢查間隔可設定 | `check_interval_seconds`。 |
| 開台啟動掛台 | Scheduler、Session Manager、Channel Session。 |
| 瀏覽器自動化 | Browser Manager、Playwright。 |
| 匯入登入狀態 | Credential Module、storageState。 |
| 維持觀看頁面有效 | Channel Session 健康檢查。 |
| 多頻道同時開台策略 | Stream Selection、`max_concurrent_streams=3`。 |
| 忠誠點數自動領取 | Reward Claimer。 |
| 領取紀錄 | Logging & Observability。 |
| 找不到按鈕不視為錯誤 | Reward Claimer 行為。 |
| 登入資料不存在提示 | Credential Module。 |
| 不輸出敏感資料 | Logger masking、安全設計。 |
| Dockerfile/docker-compose | Docker 設計。 |
| stdout/stderr 日誌 | Logging 設計。 |
| 瀏覽器崩潰復原 | Browser Manager、Channel Session。 |
| 離線釋放頁面 | Scheduler、Session Manager。 |
| 合規限制 | 安全與合規設計。 |
| mock 測試策略 | 測試設計。 |

## 16. 仍需實作前確認的低風險細節

以下項目不阻塞詳細設計，但實作前需在 issue 或 README 中明確化：

1. Twitch API access token 的產生方式與必要 scope；查詢公開 stream 狀態通常不需使用者帳號 scope，但仍需有效 app/user token。
2. Playwright storageState 匯出輔助腳本是否納入專案。
3. 忠誠點數按鈕 selector 需以實際 Twitch 頁面驗證，並可能隨 Twitch 前端變更而更新。
4. Docker base image 的 Playwright 版本需與專案相依套件鎖定一致。
