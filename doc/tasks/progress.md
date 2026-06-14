# Twitch Watchdog 實作總體進度

來源：[`doc/proposal.md`](../proposal.md)、[`doc/detailed-design.md`](../detailed-design.md)

## 模組完成情況

- [ ] [專案骨架與開發工具](project-scaffold.md)
- [ ] [Config Module](config-module.md)
- [ ] [Logging & Observability](logging-observability.md)
- [ ] [Credential Module](credential-module.md)
- [ ] [Twitch API Module](twitch-api-module.md)
- [ ] [Stream Selection Module](stream-selection-module.md)
- [ ] [Session Manager](session-manager.md)
- [ ] [Watchdog Scheduler](watchdog-scheduler.md)
- [ ] [Browser Manager](browser-manager.md)
- [ ] [Channel Session](channel-session.md)
- [ ] [Reward Claimer](reward-claimer.md)
- [ ] [測試與 Mock Twitch Pages](testing-mock-pages.md)
- [ ] [Docker 與部署文件](docker-and-docs.md)
- [ ] 全部驗收標準通過

## 建議實作順序

- [ ] 1. 完成 [專案骨架與開發工具](project-scaffold.md)。
- [ ] 2. 完成 [Logging & Observability](logging-observability.md)，讓後續模組可共用安全日誌。
- [ ] 3. 完成 [Config Module](config-module.md)。
- [ ] 4. 完成 [Credential Module](credential-module.md)。
- [ ] 5. 完成 [Twitch API Module](twitch-api-module.md)。
- [ ] 6. 完成 [Stream Selection Module](stream-selection-module.md)。
- [ ] 7. 完成 [Session Manager](session-manager.md)。
- [ ] 8. 完成 [Watchdog Scheduler](watchdog-scheduler.md)。
- [ ] 9. 完成 [Browser Manager](browser-manager.md)。
- [ ] 10. 完成 [Reward Claimer](reward-claimer.md)。
- [ ] 11. 完成 [Channel Session](channel-session.md)，整合 Browser Manager 與 Reward Claimer。
- [ ] 12. 完成 [測試與 Mock Twitch Pages](testing-mock-pages.md)。
- [ ] 13. 完成 [Docker 與部署文件](docker-and-docs.md)。
- [ ] 14. 執行整體驗收測試與 Docker smoke test。

## 驗收標準追蹤

- [ ] 使用者可使用 Dockerfile 成功建置映像檔。
- [ ] 使用者可使用 docker-compose 啟動服務。
- [ ] 使用者可透過設定檔指定至少兩個 Twitch 頻道。
- [ ] 系統可讀取掛載的 Twitch 登入狀態資料。
- [ ] 當指定頻道開台時，系統會自動開啟該頻道頁面掛台。
- [ ] 當忠誠點數按鈕出現時，系統會自動點擊領取。
- [ ] 領取成功、失敗與頻道狀態變化會被記錄於日誌。
- [ ] 容器重新啟動後，系統可再次讀取既有設定與登入狀態並恢復運作。

## 初版範圍限制追蹤

- [ ] 不實作自動輸入 Twitch 帳號密碼登入。
- [ ] 不實作多帳號管理。
- [ ] 不實作 Web UI。
- [ ] 不實作 Discord、Telegram、Email 通知。
- [ ] 不實作反偵測、繞過驗證、規避平台限制、批量帳號或大量觀看數用途。
