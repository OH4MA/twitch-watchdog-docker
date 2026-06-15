# 多頻道觀看資源最佳化方案

## 目標

在不破壞以下功能的前提下，降低同時觀看多個 Twitch 頻道時的 CPU、記憶體與網路使用量：

- 維持 Channel Points 的觀看進度。
- 自動領取 Bonus Channel Points。
- 保留頁面健康檢查、截圖與故障復原能力。
- 不繞過 Twitch 的登入、廣告、觀看或平台限制。

正式方案必須可在 Linux、macOS、Windows，以及 Docker Engine、Docker Desktop、OrbStack 與相容 OCI runtime 執行。主機直接執行 Node.js／Playwright 時也必須使用相同設定與核心邏輯。

## 跨平台設計原則

### 核心功能只使用可攜 API

正式程式只依賴：

- Node.js 標準 API。
- Playwright Browser／Context／Page API。
- 標準 DOM、HTMLMediaElement 與 Web API。
- YAML 設定。

核心功能不得依賴 Linux `/proc`、cgroup、systemd、Docker socket、macOS Instruments、Windows WMI、特定 shell 指令或特定 GPU driver。這些工具可以協助人工量測，但不能成為服務正常執行的必要條件。

### 能力偵測與安全降級

播放器 DOM、畫質名稱與可用畫質可能因頻道、地區、登入狀態或 Twitch 改版而不同。最佳化流程必須：

1. 先偵測 `<video>`、播放器設定與目標畫質。
2. 目標畫質不存在時選擇最低可用畫質。
3. 無法操作播放器設定時保留 Auto。
4. 最佳化失敗不得停止觀看 session。
5. 不依 `process.platform` 分岔核心行為。

### 不以硬體解碼作為前提

硬體解碼若由瀏覽器與 runtime 自動提供，可以視為額外效益，但正式方案不得要求：

- 掛載 Linux `/dev/dri`。
- NVIDIA Container Toolkit。
- macOS VideoToolbox 特殊設定。
- Windows DXVA 特殊設定。
- 特定 CPU 架構或 GPU。

純軟體解碼時仍必須正常運作。

## 現況與量測

2026-06-15 在目前 Docker 環境中，同時觀看 2 個頻道時的單次觀察結果：

| 項目 | 觀察值 |
| --- | ---: |
| 容器 CPU | 約 95% |
| 容器記憶體 | 約 1.74 GiB |
| Node.js RSS | 約 154 MiB |
| Firefox 主程序 RSS | 約 611 MiB |
| Firefox Web Content RSS | 約 513–524 MiB／程序 |

容器當時確實有 2 個 `watch_started` session。以上數值不是正式 benchmark，但已足以確認主要成本來自 Firefox、完整 Twitch 頁面與影音播放，而非 Telegram Bot、Twitch Helix API 或 Node.js 排程器。

目前架構已做到：

- 所有頻道共用一個 Firefox browser process。
- 所有頻道共用一個 Browser Context 與登入狀態。
- 每個實際觀看中的頻道各自建立一個 Twitch Page。
- 未被 `max_concurrent_streams` 選中的頻道只透過 Helix API 監控，不建立 Page。

因此資源使用仍會隨實際觀看 Page 數量接近線性增加。每個 Page 都包含：

- 獨立直播串流下載與影音解碼。
- Twitch React UI、播放器、聊天室與 GraphQL 狀態。
- 每頁健康檢查與 Bonus Points 掃描。
- 影片緩衝、圖片、字型、追蹤與其他頁面資源。

容器與無頭瀏覽器環境不應假設硬體影音解碼可用。不同作業系統、CPU 架構與 runtime 的硬體加速能力差異很大，因此直播解碼在部分環境中會主要消耗 CPU。

## 實作狀態

目前優化分支已完成：

- 可設定低畫質與定期校正。
- viewport 可設定但預設維持 `1280x720`，並自動靜音。
- 圖片、字型與已知 tracking hostname 可獨立阻擋，但預設關閉以保留截圖內容。
- 健康檢查與領點週期降低，並以穩定 jitter 自我排程。
- 健康檢查不再讀取完整 `body.textContent()`。
- 跨平台 runtime resource telemetry 與 JSONL 轉 CSV helper。

實際 CPU、記憶體與 Channel Points 長時間驗收仍需依 P0 測試矩陣執行。最終短時間資源快照已在 `1280x720` 且圖片、字型與 tracking 阻擋皆關閉的設定下取得。

## 建議方案總覽

依預期效益與實作風險排序：

| 優先級 | 方案 | 預期效益 | 風險 |
| --- | --- | --- | --- |
| P0 | 建立可重複的 1／2／3 頻道 benchmark | 建立可靠基準 | 低 |
| P1 | 強制低畫質並定期校正 | CPU、記憶體、流量改善最大 | 中 |
| P1 | 維持截圖 viewport 並自動靜音 | 降低音訊成本且不改變截圖 | 低 |
| P1 | 選用阻擋確認不必要的頁面資源 | 降低記憶體與流量 | 中，預設關閉 |
| P2 | 降低頁面輪詢頻率並加入 jitter | 降低週期性 CPU 峰值 | 低 |
| P2 | 精簡健康檢查 DOM 操作 | 降低主執行緒與序列化成本 | 低 |
| P3 | 加入資源 telemetry 與異常門檻 | 便於持續驗證與回歸追蹤 | 低 |

不建議直接停止影片、攔截 HLS media、快速輪流切換單一 Page，因為這些作法可能讓 Channel Points 不再計入有效觀看。

## P0：建立可重複 Benchmark

最佳化前必須先建立相同條件下的量測流程，否則 Twitch 頁面、廣告、直播畫質與主機負載會讓結果不可比較。

### 測試矩陣

分別測試：

- 1 個直播頻道。
- 2 個直播頻道。
- 3 個直播頻道。
- 預設行為。
- 各階段最佳化後行為。

每組至少執行 15 分鐘，排除啟動前 3 分鐘的頁面載入與 JIT 暖機數據。

### 記錄項目

- 容器 CPU 平均值、P95 與最大值。
- 容器記憶體平均值與最大值。
- Firefox 主程序與 Web Content RSS。
- 容器網路接收量。
- browser page crash、reload 與 restart 次數。
- Bonus Points 是否正常出現與領取。
- `/screenshot` 是否可正常取得所有 Page。

### 建議命令

Docker／OCI 環境可使用：

```bash
docker stats twitch-watchdog --no-stream
docker top twitch-watchdog -eo pid,ppid,rss,comm,args
docker compose logs --since 20m --no-log-prefix twitch-watchdog
```

主機直接執行時，不應要求跨平台腳本解析 `ps`、`top` 或 Task Manager。應提供一個純 Node.js benchmark helper，每 10 秒使用以下 API 採樣：

- `process.memoryUsage()`
- `process.cpuUsage()`
- `process.resourceUsage()`
- SessionManager 的 active session 數
- BrowserManager 的 page 數

CSV 至少包含：

```text
timestamp,process_cpu_user_us,process_cpu_system_us,rss_bytes,heap_used_bytes,active_channels,browser_pages
```

Node.js 數據不包含完整 Firefox process tree。因此跨平台共同基準使用 Node.js helper，容器總 CPU、記憶體與網路資料則由 Docker／OCI runtime 補充。平台原生工具只作診斷，不作唯一驗收依據。

### 驗收基準

最佳化版本至少應滿足：

- 2 個頻道穩定觀看時，CPU 平均值較基準降低 25%。
- 2 個頻道穩定觀看時，記憶體平均值較基準降低 15%。
- 連續 2 小時沒有新增 page crash 或 browser restart。
- Channel Points 仍可累積。
- Bonus Points 領取功能保持正常。

若 P1 完成後仍無法達到上述改善，再評估更高風險方案。

## P1：低畫質播放

### 原因

影音下載與軟體解碼是目前最可能的主要 CPU 消耗。將 Auto、720p 或 1080p 降為 160p 或 360p，通常比調整 Node.js 計時器更有效。

### 設定設計

在 `browser` 下新增：

```yaml
browser:
  stream_quality: 160p
  enforce_stream_quality_seconds: 120
```

建議允許：

- `auto`
- `160p`
- `360p`
- `480p`

預設使用 `160p`。若頻道沒有指定畫質，選擇可用的最低畫質，而不是讓 session 失敗。

### 實作方向

新增獨立的 `StreamPlaybackOptimizer`，不要將 Twitch player DOM 操作直接堆入 `ChannelSession`。

介面建議：

```ts
interface StreamPlaybackOptimizer {
  optimize(page: Page, channel: string): Promise<PlaybackOptimizationResult>;
}
```

執行時機：

1. `page.goto()` 完成後等待 player 可用。
2. 設定靜音。
3. 開啟播放器設定並選擇目標畫質。
4. 每隔設定時間確認畫質；只有 Twitch 切回 Auto 時才重新設定。
5. Page reload 後重新套用。

需要使用穩定的 `data-a-target` 或 ARIA selector，避免依賴顯示語言與按鈕文字。若 Twitch 無穩定 selector，可將 DOM adapter 集中在單一模組，方便改版時維護。

此流程只操作 Twitch Page 與標準 DOM，不依賴作業系統、browser executable path 或桌面自動化工具。

### 失敗行為

- 找不到畫質選項時記錄 debug 或 rate-limited warn。
- 不因畫質設定失敗停止觀看 session。
- 不持續快速重試。
- 每個 Page 最短 120 秒才可重新嘗試一次。
- 不記錄完整 DOM、HTML、cookie 或 token。

### 驗證

- 截圖確認播放器畫質選單已選中目標值。
- 觀察網路接收速率是否下降。
- 比較 Firefox Web Content CPU 與 RSS。
- 連續觀看至少 2 小時，確認 Twitch 不會頻繁切回 Auto。
- 確認 Points 仍持續增加。

## P1：縮小 Viewport 與靜音

### Viewport

目前 viewport 固定為 `1280x720`。建議改為設定：

```yaml
browser:
  viewport_width: 1280
  viewport_height: 720
```

預設維持原本的 `1280x720`。實機驗證顯示縮小 viewport 會改變 Twitch 響應式版面，並影響 Telegram 機器人回傳截圖，因此本輪不調降 viewport。設定仍保留供個別部署調整，但不列入預設資源最佳化。

應確認小 viewport 不會讓 Twitch 切到完全不同且無法操作畫質選單的版面。如果畫質選單在小 viewport 隱藏，`StreamPlaybackOptimizer` 可以暫時透過 DOM 或 keyboard 操作，不應為了操作選單長期保留大 viewport。

### 靜音

Page 載入後應設定：

```ts
await page.locator('video').first().evaluate((video) => {
  video.muted = true;
  video.volume = 0;
});
```

也可以優先操作 Twitch player 的 mute control，並以 `<video>` 屬性作為 fallback。靜音主要避免音訊輸出與混音成本，CPU 改善可能有限，但風險低。

`HTMLMediaElement.muted` 與 `volume` 是跨平台 Web API，不需要呼叫 ALSA、PulseAudio、CoreAudio 或 Windows Audio API。

注意：

- 不應 pause 影片。
- 不應設定 `playbackRate`。
- 不應移除 `<video>`。
- 不應攔截 audio/video media request。

## P1：阻擋非必要資源

### 原則

使用 Browser Context route 或 Page route 阻擋不影響觀看與獎勵的資源。必須採白名單式分類與逐步啟用，不能直接阻擋所有圖片、腳本或 GraphQL。

第一階段可評估阻擋：

- 字型資源。
- 頻道頁裝飾圖片與頭像。
- 已確認無關的 analytics／tracking endpoint。
- 已確認無關的廣告量測資源。

不得阻擋：

- `media`、HLS playlist、影音 segment。
- Twitch GraphQL。
- OAuth、登入與 cookie 相關請求。
- React／播放器 JavaScript bundle。
- Channel Points 相關 API。
- 可能影響觀看有效性或播放器心跳的請求。

### 設定設計

```yaml
browser:
  block_images: false
  block_fonts: false
  block_known_tracking: true
```

三項應可獨立關閉，以便快速回退。

### 實作注意

Playwright 的 `route` callback 不應做昂貴工作。規則應預先編譯，僅依 `resourceType()`、hostname 與 pathname 判定。

圖片阻擋可能影響目前的健康 selector 或截圖可讀性，但不應影響播放器本身。應先在 E2E 與實際 Twitch session 驗證。

不得使用 hosts file、iptables、pf、Windows Firewall 或平台特定 proxy 實作阻擋。所有規則必須透過 Playwright routing 套用。

### 驗證

- 比較 Page 首次載入傳輸量。
- 確認 player、Points、登入狀態與截圖正常。
- 觀察 console error 是否大量增加。
- 確認頁面沒有進入 reload loop。

## P2：降低輪詢頻率與加入 Jitter

目前每個 Page：

- 每 30 秒執行一次健康檢查。
- 每 15 秒執行一次 Bonus Points 檢查。

建議預設：

```yaml
browser:
  page_health_check_interval_seconds: 60
  reward_check_interval_seconds: 30
```

Bonus Points 通常不需要 15 秒內立即領取；30 秒仍有足夠反應速度。

### Jitter

各 session 啟動 timer 時加入穩定 jitter，避免所有 Page 在同一秒執行 DOM 查詢。

例如：

```text
effective delay = configured interval + channel hash % 5000ms
```

使用 channel 名稱產生固定 jitter，比每次完全隨機更容易測試與除錯。

建議將 `setInterval` 改為自我排程的 `setTimeout`：

1. 工作完成後才安排下一次。
2. 避免慢操作造成固定 interval 堆疊。
3. 可自然加入 jitter 與 backoff。

現有 `healthFlight` 與 `rewardFlight` 已避免同類工作重入，但自我排程仍能減少無效喚醒。

## P2：精簡健康檢查

目前錯誤判斷包含讀取整個 `body.textContent()`，這會把大型 Twitch DOM 的文字序列化回 Node.js。多 Page、每 30 秒執行時會造成額外主執行緒與 IPC 成本。

建議：

1. 優先檢查穩定的 player error selector。
2. 若需偵測 Error #4000，限制在播放器錯誤容器內查詢文字。
3. 不讀取完整 `body`。
4. 將多個 selector 檢查合併為一次 `page.evaluate()`，回傳小型 enum。

示意：

```ts
type PageHealthSignal =
  | 'login_required'
  | 'error_page'
  | 'offline'
  | 'live'
  | 'unknown';
```

Page 內只回傳一個字串，不回傳 HTML 或大段文字。

### 預期效益

此項不會像降低畫質一樣大幅降低 CPU，但屬於低風險且可避免週期性 DOM 序列化。

## P3：資源 Telemetry

長期運行服務需要知道最佳化是否失效。建議新增低頻率資源事件，例如每 5 分鐘一次：

```json
{
  "event": "runtime_resource_snapshot",
  "activeChannelCount": 2,
  "processRssBytes": 161480704,
  "processHeapUsedBytes": 28491776,
  "browserPageCount": 2
}
```

Node.js 可直接透過 `process.memoryUsage()` 取得自身資源，但容器總 CPU、Firefox RSS 與 network I/O 通常應由 Docker／主機監控收集，不建議讓應用程式讀取 Docker socket。

可在 README 提供 Prometheus node exporter、cAdvisor、Windows 或 macOS 現有監控整合方式，但不必讓本服務自行綁定管理用 HTTP port。核心 telemetry 只使用 Node.js 跨平台 API。

### 異常門檻

先只記錄，不要自動重啟。確認數據可靠後，再考慮：

- 單一 Page 長期超過預期記憶體時，重新載入該 Page。
- Page reload 無效且持續成長時，重啟 browser。
- 使用 cooldown 與每小時最大重啟次數避免 restart loop。

自動重啟是最後防線，不是資源最佳化本身。

## 不建議方案

### 停止影片或攔截 Media

可能讓 Channel Points 或 Twitch 觀看心跳停止，不符合核心需求。

### 單一 Page 輪流切換頻道

只能讓一個頻道維持有效播放，無法保留 `max_concurrent_streams > 1` 的語意。

### 只依靠 Docker Resource Limits

`cpus`、`memory` 與 `pids_limit` 可以保護主機，但不會降低實際需求。限制過低可能造成：

- Firefox tab crash。
- 頁面卡頓與獎勵進度中斷。
- Browser restart loop。
- Docker OOM kill。

可以在完成最佳化與 benchmark 後加入合理上限，作為保護措施，而不是第一步。

### 使用 Twitch Embed 或非官方純 API 取代 Page

無法確認登入狀態與 Channel Points 的有效觀看計算和目前完整 Twitch 頁一致，風險高。

### 隱藏、凍結或 Background Throttling Page

瀏覽器可能降低 timer 與 media 活性，並影響 Twitch 判定觀看狀態。除非經長時間實測確認 Points 仍增加，否則不採用。

### 平台特定硬體加速

掛載 Linux `/dev/dri`、使用 NVIDIA runtime、強制 macOS VideoToolbox 或 Windows DXVA 可能在特定設備有效，但部署差異、driver 與瀏覽器支援成本過高。

此類調整只能作為進階部署附錄，不可放入預設 Docker Compose，也不能成為本方案的必要條件。

## 建議設定草案

完成 P1 與 P2 後，建議預設設定如下：

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
```

`block_known_tracking` 初期預設應為 `false`，待建立足夠 endpoint 測試與實際觀看證據後才改為預設啟用。

## 實作拆分

建議分成獨立 commits，便於 benchmark 與回退：

1. `加入多頻道資源 benchmark 腳本`
2. `加入播放器低畫質與靜音設定`
3. `加入可設定 viewport 與靜態資源阻擋`
4. `降低頁面輪詢成本並加入 jitter`
5. `精簡 Twitch 頁面健康檢查`
6. `加入 runtime resource telemetry`

每個 commit 都必須通過：

- lint
- TypeScript build
- unit tests
- Playwright E2E
- Docker smoke
- 至少一次實際 Twitch 單頻道與雙頻道觀察

跨平台 CI 最低矩陣：

- Ubuntu x86_64：lint、build、unit、E2E。
- macOS Intel 或 Apple Silicon：lint、build、unit、E2E。
- Windows x86_64：lint、build、unit、E2E。

Docker smoke 可集中在 Linux CI。macOS 與 Windows CI 不應因缺少相同 container runtime 而阻擋主機模式測試。

## 推薦執行順序

第一階段先完成 benchmark、低畫質、靜音與 viewport。這四項最有機會快速確認實際效益。

第二階段加入圖片／字型阻擋、timer jitter 與健康檢查精簡。

第三階段持續運行至少 24 小時，比較：

- CPU 平均與 P95。
- 記憶體成長曲線。
- 每頻道網路流量。
- Points 進度。
- Page crash、reload、browser restart 次數。

只有在長時間驗證通過後，才將新選項設為正式預設值。

## 最終建議

此專案的資源成本主要由「每個頻道一個完整且持續播放的 Twitch 頁面」決定，不可能在保留多頻道有效觀看的前提下完全消除線性成長。

最可行的完整方案是：

1. 強制最低可用畫質。
2. 維持 `1280x720` viewport，僅自動靜音。
3. 保留圖片、字型與 tracking 阻擋開關，但預設關閉以維持機器人截圖。
4. 將健康檢查調整為 60 秒、獎勵檢查調整為 30 秒。
5. 將各 Page 的週期工作錯開。
6. 移除完整 `body.textContent()` 健康掃描。
7. 用 benchmark 與長時間 Points 實測決定是否採用為預設。

預期最大改善會來自降低影片畫質；其餘措施用於降低頁面渲染、網路與週期性 DOM 工作的額外成本。

上述正式措施都能以 Node.js、Playwright 與標準 Web API 實作，不需要平台特定系統呼叫。容器資源限制、硬體解碼與原生效能工具只作選用的部署保護或診斷手段。
