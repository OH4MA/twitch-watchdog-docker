# 專案骨架與開發工具任務

來源：[`doc/proposal.md`](../proposal.md)、[`doc/detailed-design.md`](../detailed-design.md)

## 模組目標

建立 Node.js + TypeScript + Playwright 專案骨架，讓後續模組能以一致的目錄、測試、建置與執行方式開發。

## 最小可執行任務

- [ ] 初始化 `package.json`，加入 `typescript`、`tsx` 或等效開發執行工具。
- [ ] 加入 Playwright 與測試框架（Vitest 或 Jest；Playwright test 可後續加入）。
- [ ] 建立 `tsconfig.json`，輸出目錄設定為 `dist`。
- [ ] 建立 `src/index.ts` 作為程式入口點，先輸出啟動訊息即可。
- [ ] 建立設計文件建議的基本目錄：`src/app`、`src/config`、`src/credentials`、`src/twitch`、`src/scheduler`、`src/browser`、`src/sessions`、`src/logging`、`src/types`。
- [ ] 建立測試目錄：`test/fixtures`、`test/mock-pages`、`test/unit`、`test/integration`、`test/e2e`。
- [ ] 在 `package.json` 加入 `build`、`start`、`test`、`lint` 或最小等效 scripts。
- [ ] 加入 `.gitignore`，至少忽略 `node_modules/`、`dist/`、`.env`、`data/browser-state/`、`*.storage-state.json`、`storage-state.json`。
- [ ] 執行一次 TypeScript build，確認空骨架可編譯。
- [ ] 執行一次測試命令，確認測試框架可啟動。

## 完成定義

- [ ] `npm run build` 成功。
- [ ] `npm test` 成功。
- [ ] `npm start` 或等效命令可啟動入口點。
- [ ] 目錄結構與詳細設計第 12 節相容。
