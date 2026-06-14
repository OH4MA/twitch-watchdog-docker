# Docker 與部署文件任務

來源：[`doc/proposal.md`](../proposal.md) 第 3.6 節、第 4 節、第 8 節，及 [`doc/detailed-design.md`](../detailed-design.md) 第 8 節、第 9 節、第 11 節

## 模組目標

提供可建置與啟動服務的 Dockerfile、docker-compose.yml、範例設定檔與使用文件，並確保登入狀態與敏感資訊不被寫入 image 或日誌。

## 最小可執行任務

- [x] 建立 `config.example.yml`，包含 channels、check interval、max concurrent streams、headless、storage state path、log level、Twitch API 設定與 browser 子設定。
- [x] 在 `config.example.yml` 使用 placeholder，不放入真實 token 或 cookie。
- [x] 建立 `Dockerfile`，使用 Playwright 官方 Node.js base image 或等效方案。
- [x] 確保 Dockerfile 中 Playwright 版本與 `package.json` 相依版本一致。
- [x] Dockerfile build 流程：安裝 production dependencies、複製 `dist`、設定 `NODE_ENV=production`、設定 `CONFIG_PATH=/app/config.yml`。
- [x] 建立 `docker-compose.yml`，包含 build、container_name、restart、environment、volumes、`shm_size: "1gb"`。
- [x] docker-compose volume 掛載 `./config.yml:/app/config.yml:ro`。
- [x] docker-compose volume 掛載 `./data/browser-state:/data/browser-state:ro`。
- [x] 確保應用日誌輸出 stdout/stderr，不寫入固定 log file。
- [x] 補齊 README 或專用文件：如何建立設定檔。
- [x] 補齊 README 或專用文件：如何取得 Twitch API client id 與 access token（不得要求帳號密碼寫入專案）。
- [x] 補齊 README 或專用文件：如何匯出 Playwright storageState 到 `./data/browser-state/storage-state.json`。
- [x] 補齊 README 或專用文件：storageState 等同登入憑證，請勿提交、分享，並建議檔案權限。
- [x] 補齊 README 或專用文件：本工具僅供使用者自己擁有或授權使用的 Twitch 帳號，需自行確認 Twitch 服務條款與社群規範。
- [x] 補齊 README 或專用文件：不支援自動登入、多帳號、反偵測、繞過驗證或大量擴張觀看數。
- [x] 撰寫 Docker smoke test 步驟：`docker build` 可成功。
- [x] 撰寫 Docker smoke test 步驟：`docker compose up` 可讀取設定與 storageState，並輸出啟動日誌。
- [x] 測試容器重啟後可重新讀取既有設定與登入狀態。

## 完成定義

- [x] `docker build` 成功。
- [x] `docker compose up` 可啟動服務。
- [x] 文件包含設定、storageState 匯入、安全提醒與執行方式。
- [x] Docker image 不包含使用者 storageState、cookie、token 或真實設定。
