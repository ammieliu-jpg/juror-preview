# 這次換你判：AI 國民法官預演室

NextWave 2026 AI法創黑客松參賽原型（**非官方，與司法院無關**）。

> **官方調查表不改，我們幫民眾看懂它、幫書記官審完它。**

收到國民法官通知的人，有一半沒有到場（113 年到場率 48.9%）。最多人擔心的是「聽不懂法律用語、不了解案情」，而不是錢。
這個原型分兩端：

| | 民眾端 | 法院端 |
|---|---|---|
| 網址 | <https://ammieliu-jpg.github.io/juror-preview/> | <https://ammieliu-jpg.github.io/juror-preview/court.html> |
| 做什麼 | 8 個像素場景，走一遍從收到通知、填調查表、選任宣誓到評議表決；右下角手機隨時問常見問答 | 統計回覆、預測到場人數；免除申請由「規則＋AI」初篩，標出需要書記官確認的人 |
| AI 怎麼用 | 瀏覽器內的中文語意模型（bge-small-zh-v1.5）比對 41 題司法院常見問答＋20 題補充，附出處；不需登入、問題不離開瀏覽器 | 規則先判年齡、在學、法定職業等明確情況（不花 token）；判不了才交給 Gemini（正式版換 TAIDE），結果經白名單檢查，最後由法官決定 |

## 快速開始

```bash
# 本機預覽（任何靜態伺服器都可以）
python3 -m http.server 8000
# 打開 http://localhost:8000/ 與 http://localhost:8000/court.html

# 測試（Node.js 20 以上，不需安裝套件）
npm test          # 單元測試
npm run eval      # 規則層準確度評估
npm run build:gs  # 改了 lib/screening.js 或 apps-script/main.gs 後，重新產生 apps-script/Code.gs
npm run check     # push 前跑：檢查 Code.gs 已同步＋全部測試
```

法院端不設定也能看：按「載入示範資料」。要接上真正的表單，照 [docs/SETUP.md](docs/SETUP.md)。

## 檔案

```
index.html              民眾端：像素遊戲＋問答小幫手
court.html / court.js   法院端儀表板（版面＋CSP／程式）
lib/screening.js        免除初篩：事由清單、規則、AI 回傳檢查（court.html 與 Apps Script 共用）
lib/qa-search.js        問答比對（關鍵字、語意＋關鍵字混合）
apps-script/main.gs     Apps Script 原始碼（表單送出 → 分類 → 寫回試算表 → 儀表板資料）
apps-script/Code.gs     自動產生，貼進 Apps Script 的就是這個檔
prompts/                PartyRock 提示詞（模組 2、3、5、6）
tests/                  單元測試、25 筆標註案例、準確度評估
docs/                   說明文件
```

## 文件

| 文件 | 內容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架構圖：全貌、一筆回覆的旅程、初篩流程、問答流程、信任邊界、程式結構、部署 |
| [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) | 安全與架構審查：所有發現與處理狀態 |
| [docs/DATA_SCHEMA.md](docs/DATA_SCHEMA.md) | 表單、試算表、模組 4、Looker Studio、court.html 的欄位對照 |
| [docs/SETUP.md](docs/SETUP.md) | Gemini 金鑰、Apps Script、網頁應用程式、儀表板、Looker Studio 設定步驟 |
| [docs/REFACTORING.md](docs/REFACTORING.md) | 已完成與建議的重構、單元測試寫法與範例 |
| [docs/PROMPTS.md](docs/PROMPTS.md) | 6 個 AI 模組、提示詞放在哪、改了要同步哪裡 |
| [CHANGELOG.md](CHANGELOG.md) | 修改紀錄 |

## 資料來源與授權

- 司法院國民法官專區常見問答（Q3601–Q3641）、司法院公開之模擬法庭教材（臺北地院 111 年度國模交訴字第 1 號，人名改為代號），依[政府資料開放授權條款第 1 版](https://data.gov.tw/license)使用。不使用司法院標誌。
- 統計數字：司法院 113 年度國民參與審判制度成效評估報告。
- 字型：Noto Sans TC、Silkscreen（Google Fonts，SIL OFL）。
- 語意模型：[Xenova/bge-small-zh-v1.5](https://huggingface.co/Xenova/bge-small-zh-v1.5)（MIT），透過 [transformers.js](https://github.com/huggingface/transformers.js) 3.0.2 在瀏覽器執行。

## 注意

- 所有示範資料都是虛構的。示範表單**不是**法院的表單，請勿填寫真實個資。
- 免費版 Gemini API 的資料可能被 Google 用來改進模型；正式上線應改用法院自建模型，個資不離開法院。
- AI 結果只是初步整理，是否准許免除由法官決定。
