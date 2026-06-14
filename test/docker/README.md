# Docker smoke test

執行：

```bash
./scripts/docker-smoke.sh
```

測試會：

1. 驗證正式與 smoke Compose 合併結果。
2. 建置 `smoke-test` target，於映像內執行 lint、build、Vitest 與 Playwright E2E。
3. 建置 production image，確認只含 production dependencies、`dist` 與必要 metadata。
4. 確認 image 不含 `config.yml`、`.env`、storageState、原始碼或測試。
5. 確認缺少 `/app/config.yml` 時 production command 會以非零狀態清楚失敗。
6. 使用測試專用 Compose override 啟動與重啟服務，確認 SIGTERM 會輸出 `service_stopped`。

Smoke Compose 使用假憑證、空 storageState 與 `network_mode: none`。應用程式無法連線 Helix 或 Twitch 網站，因此測試不依賴也不會存取正式服務。
