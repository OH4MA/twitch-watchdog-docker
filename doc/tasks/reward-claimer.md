# Reward Claimer 任務

來源：[`doc/proposal.md`](../proposal.md) 第 3.3 節、[`doc/detailed-design.md`](../detailed-design.md) 第 5.9 節

## 模組目標

在已開啟的 Twitch 頻道頁面中偵測忠誠點數獎勵按鈕，按鈕可點擊時自動領取，並回報 claimed、not_found 或 click_failed。

## 最小可執行任務

- [ ] 定義 `RewardClaimResult` union 型別：`claimed`、`not_found`、`click_failed`。
- [ ] 定義 `RewardClaimer` 介面：`claimIfAvailable(page, channel)`。
- [ ] 實作 primary selector：`[data-test-selector="community-points-claim-button"]`。
- [ ] 實作 community points 區域 selector 輔助搜尋：`[data-test-selector="community-points-summary"]`。
- [ ] 實作結構式 fallback：在 community points 區域中尋找可見且可點擊的 button-like element。
- [ ] 可選擇加入語系文字 fallback，但不得作為唯一定位方式。
- [ ] 找不到按鈕時回傳 `{ status: 'not_found', channel, checkedAt }`，不視為錯誤。
- [ ] 找到但不可見或 disabled 時回傳 `not_found` 或 debug 事件。
- [ ] 點擊成功時回傳 `{ status: 'claimed', channel, claimedAt }` 並記錄 `reward_claimed`。
- [ ] 點擊失敗時回傳 `{ status: 'click_failed', channel, checkedAt, error }` 並記錄 `reward_claim_failed`。
- [ ] 實作同一 channel 成功點擊後 60 秒冷卻，避免快速重複點擊。
- [ ] 確保錯誤訊息不包含 cookie、token 或 storageState。
- [ ] 撰寫 mock page 單元測試：primary selector 存在時會點擊。
- [ ] 撰寫 mock page 單元測試：按鈕不存在時回傳 `not_found`。
- [ ] 撰寫 mock page 單元測試：按鈕 disabled 時不點擊。
- [ ] 撰寫 mock page 單元測試：點擊拋錯時回傳 `click_failed`。
- [ ] 撰寫 mock page 單元測試：冷卻期間不重複點擊。
- [ ] 建立 mock Twitch pages：`reward-available.html`、`reward-disabled.html`、無 reward 按鈕頁。
- [ ] 撰寫 Playwright integration test，驗證 mock page 上的按鈕會被點擊。

## 完成定義

- [ ] Reward Claimer 單元測試與 mock page 測試全部通過。
- [ ] 找不到 reward 按鈕不會產生錯誤日誌。
- [ ] 成功與失敗結果都有明確結構化回傳。
- [ ] selector 策略不依賴單一語系文字。
