# 修改紀錄

## 2026-11-04　全面審查與重構

詳見 [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)。

**安全**
- Apps Script 寫入試算表前防公式注入（`sanitizeCell`）
- 法院端改讀 Apps Script 網頁應用程式＋存取碼，試算表不必公開
- court.html 加 CSP，程式移到 `court.js`；Gemini 金鑰預設只存 sessionStorage
- Apps Script 加鎖（同時送出）、5 分鐘時限（避免 6 分鐘上限中斷）、候選人編號格式檢查

**正確性**
- 規則初篩不再把家人的年齡、學生身分、職業當成申請人的；「曾任國民法官」不再被當成職業法官；否定句不算
- 提示詞（`RULES_PROMPT`、PartyRock 模組 3、6）新增「只看申請人本人」
- 到場預測計入「尚未決定」

**架構**
- `lib/screening.js`：court.html 與 Apps Script 共用同一份初篩邏輯；`npm run build:gs` 產生 `apps-script/Code.gs`
- `lib/qa-search.js`：問答比對抽出成純函式
- Apps Script 新增 `rebuildDashboard()`，產生模組 4 格式的「回覆資料」「到場預測」給 Looker Studio
- Apps Script 用標題找表單欄位，題目順序改了也不怕

**民眾端**
- 「正式回覆法院」改為「看懂調查表、試填一次（示範）」，並提醒真正的回覆請用官方線上調查表

**測試與文件**
- 61 項單元測試、25 筆標註案例、`npm run eval`、GitHub Actions
- 新增 docs/：架構圖、審查報告、資料格式、設定步驟、重構建議、提示詞說明

## 2026-10-31　PR #1

- 預填網址不再包含健康說明
- 提示注入防護與 AI 回傳白名單
- 模組 3、6 與 Apps Script 改用完整的第 13～16 條事由清單
