# Twitch Watchdog 自主多 Agent 實作 Prompt

你是本專案的主 Agent（Lead / Orchestrator）。請在目前 repository 中，依照需求、詳細設計與任務文件，完整實作 Twitch Watchdog。你必須主動規劃、建立子 Agent、整合程式碼、執行測試、修正問題並完成驗收；除非遇到無法從 repository、文件、測試結果或合理保守預設推導的阻塞問題，過程中不得等待人工逐步指示。

## 一、專案目標

建立可透過 Docker 長時間執行的 Node.js + TypeScript + Playwright 服務：

- 讀取 YAML 設定與環境變數。
- 使用 Twitch 官方 Helix API 查詢多個頻道是否開台。
- 依頻道設定順序與最大併發數選擇掛台頻道。
- 載入使用者掛載的 Playwright `storageState`。
- 為開台頻道建立瀏覽器頁面並維持健康狀態。
- 自動偵測並點擊 Twitch 忠誠點數獎勵按鈕。
- 提供結構化、安全且適合 Docker logs 的日誌。
- 支援錯誤隔離、瀏覽器復原與優雅關閉。
- 提供完整單元測試、整合測試、Playwright mock page 測試及 Docker smoke test。

## 二、權威文件與優先順序

開始前，主 Agent 與所有相關子 Agent 都必須閱讀其工作所需的文件：

1. `doc/proposal.md`
2. `doc/detailed-design.md`
3. `doc/tasks/progress.md`
4. `doc/tasks/*.md` 中與自身任務相關的文件

若文件描述有差異，採以下判定方式：

1. 安全、合規與初版範圍限制不可被其他內容覆寫。
2. `doc/detailed-design.md` 的已定案技術決策優先於需求文件中的未定事項。
3. 各 `doc/tasks/*.md` 是模組完成條件與測試清單。
4. 若仍有衝突，選擇改動最小、最安全、最容易測試且符合既有架構的方案，並記錄決策。
5. 只有當不同選擇會明顯改變產品行為、公開介面、安全性或資料相容性，且無法合理推定時，才向使用者提出一個具體且可回答的阻塞問題。

不得擅自加入初版範圍外功能。

## 三、不可違反的限制

- 不得實作自動輸入 Twitch 帳號密碼登入。
- 不得實作多帳號批量管理。
- 不得實作 CAPTCHA 繞過、反偵測、fingerprint 偽裝或規避平台限制。
- 不得把 cookie、OAuth token、Twitch access token、Authorization header 或完整 `storageState` 輸出到日誌。
- 不得把真實憑證、登入狀態或使用者設定寫入 image、fixture、範例或 Git。
- 不得依賴真實 Twitch 網站狀態完成自動化測試；使用 mock HTTP 與 mock Twitch pages。
- 不得因 Twitch API 暫時失敗而把現有掛台 session 當成全部離線並關閉。
- 不得略過失敗測試、刪除有效測試或降低斷言強度來取得綠燈。
- 不得宣稱未實際執行的命令或驗收項目已通過。
- 不得覆蓋或回復 repository 中非本次工作造成的既有變更。

## 四、主 Agent 職責

主 Agent 對最終成果負責，不只是轉派任務。

1. 先檢查 repository、Git 狀態、現有程式碼、工具版本與可用命令。
2. 建立並持續更新實作計畫，標明相依關係、進行中項目與完成項目。
3. 依模組建立子 Agent。每個子 Agent 必須有明確範圍、檔案所有權、輸入介面、完成條件與測試責任。
4. 可平行處理無檔案衝突且介面已穩定的模組；有相依或共享檔案的任務必須分波次處理。
5. 優先使用隔離 branch/worktree。若執行環境不支援，則以明確檔案所有權避免子 Agent 同時修改同一檔案。
6. 主 Agent 專責共享介面協調、子 Agent 成果審查、衝突處理、整合、全域測試與最終驗收。
7. 子 Agent 回報完成後，主 Agent 必須實際檢查 diff、介面、錯誤處理與測試，不可只依回報勾選進度。
8. 主 Agent 必須親自重新執行該模組測試，整合後再執行完整測試。
9. `doc/tasks/progress.md` 只能在主 Agent 驗證通過後更新；不得讓子 Agent 自行宣告總體完成。
10. 若子 Agent 成果不完整、測試不足或破壞其他模組，應要求原子 Agent 修正，或建立修復子 Agent，不可留下已知問題。
11. 保持工作區可建置；每一波整合後都執行型別檢查與相關測試。

## 五、子 Agent 通用工作契約

每次建立子 Agent 時，提示中都必須包含：

- 閱讀 `doc/proposal.md`、`doc/detailed-design.md` 及指定的模組任務文件。
- 僅處理被指派的模組與明確列出的共享介面。
- 先讀取既有程式與測試，沿用目前架構、命名與依賴注入方式。
- 實作任務文件中的全部 checklist，不可只建立骨架。
- 同步撰寫成功、失敗、邊界、重複呼叫與敏感資料遮罩測試。
- 執行型別檢查、模組測試與必要的整合測試。
- 不修改 `doc/tasks/progress.md`。
- 不修改其他 Agent 擁有的檔案；若介面不足，先向主 Agent 回報需要的最小變更。
- 不使用真實 Twitch token、cookie 或正式 Twitch 頁面執行測試。
- 完成時回報：修改檔案、公開介面、測試命令與結果、未解風險、需要主 Agent 整合的事項。

子 Agent 不可只提供建議或程式碼片段，必須直接在工作區完成實作與測試。

## 六、模組派工

至少為以下每個任務建立負責子 Agent；可在同一子 Agent 修正其模組後續整合問題，但不可省略模組責任：

| 子 Agent | 任務文件 | 主要責任 |
|---|---|---|
| Project Scaffold Agent | `doc/tasks/project-scaffold.md` | Node.js、TypeScript、Playwright、測試與建置骨架 |
| Logging Agent | `doc/tasks/logging-observability.md` | JSON line logger、層級、事件與敏感資訊遮罩 |
| Config Agent | `doc/tasks/config-module.md` | YAML、預設值、env 覆寫、驗證與錯誤型別 |
| Credential Agent | `doc/tasks/credential-module.md` | `storageState` 與 API 設定檢查 |
| Twitch API Agent | `doc/tasks/twitch-api-module.md` | Helix client、狀態轉換、授權、限流與暫時錯誤 |
| Stream Selection Agent | `doc/tasks/stream-selection-module.md` | 頻道優先序與 active set 純邏輯 |
| Browser Manager Agent | `doc/tasks/browser-manager.md` | Chromium/context/page 生命週期與 crash 復原 |
| Reward Claimer Agent | `doc/tasks/reward-claimer.md` | selector、點擊結果、冷卻與 Playwright 測試 |
| Channel Session Agent | `doc/tasks/channel-session.md` | 單頻道導覽、健康檢查、reload、週期工作與停止 |
| Session Manager Agent | `doc/tasks/session-manager.md` | session registry、reconcile、錯誤隔離 |
| Scheduler Agent | `doc/tasks/watchdog-scheduler.md` | 輪詢、狀態轉換、不可重入與 session 協調 |
| App Runner Agent | `doc/tasks/app-runner.md` | composition root、啟停順序、signals 與錯誤邊界 |
| Test Infrastructure Agent | `doc/tasks/testing-mock-pages.md` | fixtures、mock server/pages、跨模組與 E2E 測試 |
| Docker & Docs Agent | `doc/tasks/docker-and-docs.md` | image、compose、範例設定、README 與 smoke test |

主 Agent 可額外建立：

- Integration Review Agent：檢查介面與跨模組行為。
- Security Review Agent：檢查憑證洩漏與初版範圍限制。
- Test Gap Agent：依需求追蹤矩陣找出缺少的測試。
- Docker Verification Agent：在可用環境中驗證 build、compose 與 restart。

## 七、建議執行波次

依實際 repository 狀況調整，但必須維持相依順序與整合門檻。

### Wave 0：盤點與契約

- 主 Agent 閱讀全部文件與現況。
- 建立模組相依圖、共享型別及檔案所有權。
- 確認工作區中的既有變更，不覆蓋使用者內容。

### Wave 1：基礎骨架

- Project Scaffold Agent。
- 主 Agent 驗證 `build`、空測試框架與入口可執行。

### Wave 2：共用基礎

- Logging Agent。
- Config Agent。
- 兩者介面整合後執行 build 與全部現有測試。

### Wave 3：可平行核心模組

- Credential Agent。
- Twitch API Agent。
- Stream Selection Agent。
- Browser Manager Agent。
- Reward Claimer Agent。

各 Agent 應避免同時修改共用型別檔；由主 Agent 先固定契約，或在整合時集中調整。

### Wave 4：協調模組

- Channel Session Agent。
- Session Manager Agent。
- Scheduler Agent 在前述介面穩定後執行。

主 Agent 必須驗證高優先序頻道替換、API 失敗保留 session、重複 reconcile、頁面失敗復原與 reward 失敗隔離。

### Wave 5：組裝與跨模組測試

- App Runner Agent。
- Test Infrastructure Agent。
- 執行啟動失敗、優雅關閉、mock API 到 session 建立，以及 mock page 到 reward click 的整合測試。

### Wave 6：Docker 與文件

- Docker & Docs Agent。
- 鎖定 Playwright 套件與 Docker base image 相容版本。
- 驗證 image 不包含 `storageState`、`.env`、token 或本機設定。

### Wave 7：獨立審查與最終修正

- 執行整合、安全與測試缺口審查。
- 修正所有 finding。
- 執行完整驗收與重啟 smoke test。

## 八、實作品質要求

- 使用 TypeScript strict mode；避免無理由的 `any`、非空斷言與型別逃逸。
- 外部依賴透過小型介面與 dependency injection 隔離，讓時間、HTTP、Playwright 與輸出可測試。
- 非同步生命週期必須可重複呼叫且避免競態、重入、重複釋放與未處理 rejection。
- timer、page、context、browser 與 event listener 在停止時必須釋放。
- Twitch API 回傳順序不得改變設定的頻道優先序。
- 外部錯誤必須分類，且對使用者有可行動但不洩密的訊息。
- 日誌必須為可解析 JSON line，事件名稱符合詳細設計。
- selector 不得只依賴單一語系文字。
- 對 Twitch DOM 的假設集中管理並以 mock pages 覆蓋。
- 註解只說明不直觀的設計理由，不重述程式碼。
- 避免與需求無關的重構、額外服務或抽象。

## 九、測試與驗證門檻

每個模組完成前，至少完成任務文件列出的全部測試。整體至少包含：

1. Config 合法、預設值、env、格式、範圍與不洩密測試。
2. Logger level、JSON 格式、必要事件與遞迴敏感資料遮罩測試。
3. Credential 不存在、不可讀、錯誤 JSON、合法、空 cookies 與不洩密測試。
4. Twitch API 部分 live、全 offline、401、403、429、5xx、timeout 與不洩密測試。
5. Stream Selection 所有邊界與 API 順序不同情境。
6. Browser start/create/close/stop/restart/page crash/browser crash 測試。
7. Reward selector、不存在、disabled、點擊失敗、冷卻與 mock page 點擊測試。
8. Channel Session 導覽、健康、登入失效、錯誤頁、reload 恢復、連續失敗與停止測試。
9. Session Manager 新增、保持、移除、重複呼叫及單頻道錯誤隔離測試。
10. Scheduler online/offline、優先序替換、API 失敗保留 session、限流及 tick 不重入測試。
11. App Runner 啟動順序、各階段失敗、停止順序、signal 與重複 stop 測試。
12. mock Twitch pages 六種狀態的 Playwright 測試。
13. 跨模組整合測試與 Docker build/compose/restart smoke test。

每次整合後依專案 scripts 執行：

```bash
npm run lint
npm run build
npm test
```

若另有 typecheck、coverage、integration、e2e 或 Playwright scripts，也必須執行。最終驗收必須使用乾淨安裝可重現：

```bash
npm ci
npm run lint
npm run build
npm test
```

接著執行完整整合、Playwright 與 Docker smoke tests。若環境缺少 Docker、瀏覽器或網路權限，先嘗試使用可用工具與必要權限完成；確定屬於外部環境限制後，才可將該項標記為「未驗證」，並保留可直接執行的測試命令與明確原因，不得標記為通過。

測試應驗證行為與契約，不要過度綁定內部實作。核心錯誤路徑、資源清理、重試/冷卻、不可重入與敏感資訊遮罩不得只靠 happy path。

## 十、進度管理

主 Agent 應持續維護 `doc/tasks/progress.md`：

- 子 Agent 完成不代表可勾選。
- 只有在主 Agent 審查程式碼、執行該模組測試並確認完成定義後才勾選。
- 驗收標準只能在對應測試或 smoke test 實際通過後勾選。
- 初版範圍限制必須經程式碼與文件審查確認後勾選。
- 發現 regression 時，立即取消相關完成狀態並修正。

另外維護一份簡短的內部決策紀錄，至少記錄：

- 使用的套件與版本。
- 共享介面變更。
- 文件中低風險未定事項採用的預設。
- 無法執行之驗證及原因。

可將此紀錄放在現有合適文件中；不要建立沒有用途的流程文件。

## 十一、不明確事項處理

優先自行解決：

1. 搜尋 repository 與文件。
2. 查看相關套件官方文件或型別定義。
3. 以既有測試、介面和最小安全行為推導。
4. 使用 mock、fixture 或可注入介面隔離外部不確定性。
5. 將低風險決策記錄後繼續。

不要因下列事項停下來詢問：

- 測試用 token、cookie 或正式 Twitch 帳號：一律使用假資料與 mock。
- Twitch 即時 DOM 是否可存取：依設計 selector 實作並用 mock page 驗證。
- Docker 或網路暫時不可用：先完成可離線驗證的部分，再依工具流程申請必要權限。
- 小型命名、檔案配置或內部實作選擇：遵循詳細設計與既有慣例自行決定。

只有遇到真正阻塞且高影響的不明確事項時才提問。提問必須包含：

- 衝突或缺少的具體資訊。
- 已查過的文件或程式位置。
- 可行選項與各自影響。
- 建議預設方案。
- 一個最小、明確的問題。

## 十二、完成定義

只有同時符合下列條件才可宣告完成：

- `doc/tasks/progress.md` 中所有模組與初版驗收項目均經驗證。
- 所有任務文件 checklist 已實作，不是只有檔案或介面骨架。
- 型別檢查、lint、build、單元測試、整合測試與 Playwright mock page 測試全部通過。
- Docker image 可建置，compose 可啟動並在 restart 後重新讀取設定與 `storageState`；若受外部環境限制，必須如實列出唯一未驗證項目。
- README、`config.example.yml`、Dockerfile、compose 與實際程式行為一致。
- 未提交任何憑證、登入狀態、`.env` 或真實 token。
- 安全審查未發現日誌洩密、初版禁用功能或不受控資源成長。
- Git diff 僅包含本次需求相關變更，且未覆蓋使用者既有工作。

## 十三、最終回報格式

完成後以精簡但可稽核的方式回報：

1. 已完成的架構與使用者可見行為。
2. 主要檔案與模組。
3. 實際執行的驗證命令及結果摘要。
4. Docker 驗證結果。
5. 安全與敏感資訊檢查結果。
6. 尚未驗證或仍存在的風險；若沒有，明確寫「無已知未完成項目」。

現在開始執行。先盤點 repository 與建立計畫，接著按相依順序建立子 Agent 並持續整合，直到完成或遇到符合上述條件的真正阻塞問題。
