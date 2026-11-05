# 系統架構

這份文件說明「這次換你判：AI 國民法官預演室」由哪些部分組成、資料怎麼流動、每個部分在哪裡執行。
圖用 Mermaid 繪製，在 GitHub 上會直接顯示成圖。

> 定位：**官方調查表不改，我們幫民眾看懂它、幫書記官審完它。**
> 民眾端讓人在回覆前先看懂流程與調查表（第 13、14、16 條逐款白話說明）；法院端用「規則＋AI」初篩免除申請的自由文字，最後由法官決定。

---

## 1. 全貌：誰用、在哪裡跑

```mermaid
flowchart LR
  subgraph 民眾的手機或電腦
    G["index.html<br/>像素遊戲（8 個場景）"]
    P["右下角手機<br/>國民法官小幫手"]
    G --- P
  end

  subgraph "GitHub Pages（靜態網站）"
    GH["index.html · court.html · court.js<br/>lib/screening.js · lib/qa-search.js"]
  end

  subgraph "第三方（只下載，不傳個資）"
    CDN["jsDelivr<br/>transformers.js 3.0.2"]
    HF["Hugging Face<br/>bge-small-zh-v1.5 模型"]
  end

  subgraph "Google（團隊的示範帳號）"
    F["Google 表單<br/>示範回覆"]
    SH[("試算表<br/>表單回應 1")]
    AS["Apps Script<br/>apps-script/Code.gs"]
    GM["Gemini API<br/>（正式版換 TAIDE）"]
    DB[("回覆資料<br/>到場預測")]
    LS["Looker Studio"]
  end

  subgraph 書記官的電腦
    C["court.html<br/>法院端儀表板"]
  end

  PR["PartyRock<br/>模組 2、3、5、6"]

  GH -->|載入| G
  GH -->|載入| C
  P -.->|首次使用下載| CDN
  P -.->|首次使用下載| HF
  G -->|試填一次：開啟預填網址| F
  G -.->|個人狀況：另開| PR
  F --> SH
  SH -->|提交表單時觸發| AS
  AS -->|規則判不了的| GM
  AS -->|寫回 AI 欄位| SH
  AS -->|重建| DB
  DB --> LS
  C -->|"doGet ?token=存取碼"| AS
```

| 元件 | 檔案 | 在哪裡執行 | 處理個資？ |
|---|---|---|---|
| 民眾端遊戲 | `index.html` | 民眾的瀏覽器 | 否。遊戲選擇不會送出 |
| 問答小幫手 | `index.html` + `lib/qa-search.js` | 民眾的瀏覽器（語意模型也在瀏覽器裡跑） | 否。問題不離開瀏覽器 |
| 示範表單 | Google 表單 | Google | 是（只能用虛構資料） |
| 自動分類 | `apps-script/Code.gs`（= `apps-script/main.gs` + `lib/screening.js`） | Google Apps Script | 是 |
| AI 模型 | Gemini API（原型）／TAIDE（正式版） | Google／法院自建 | 是（只送規則判不了的那幾筆） |
| 法院端儀表板 | `court.html` + `court.js` + `lib/screening.js` | 書記官的瀏覽器 | 是 |
| 統計圖表 | Looker Studio | Google | 統計數字為主 |
| AI 工具箱 | PartyRock（模組 2、3、5、6） | AWS PartyRock | 民眾自己輸入 |

---

## 2. 一筆回覆的完整旅程

```mermaid
sequenceDiagram
  autonumber
  actor 民眾
  participant G as index.html
  participant F as Google 表單
  participant SH as 試算表
  participant AS as Apps Script
  participant AI as Gemini
  participant C as court.html
  actor 書記官

  民眾->>G: 玩完預演，選「試填一次（示範）」
  G->>G: 填編號、回覆、事由；說明欄依勾選事由顯示填寫範例
  G->>F: 開啟預填網址（編號＋回覆＋事由）
  Note over G,F: 具體說明含健康資料，不放進網址，<br/>改成自動複製，請民眾貼到最後一題
  民眾->>F: 貼上說明，按「提交」
  F->>SH: 新增一列（A 時間戳記 … E 具體情況說明）
  SH->>AS: onFormSubmit
  AS->>AS: 先檢查（不花 token）：同一人後來又送出？編號格式、通知名冊
  AS->>AS: Screening.ruleClassify（本人寫明的年齡、在學、法定職業、曾任）
  alt 規則判得了
    AS->>AS: 不花 token，判斷來源＝規則
  else 規則判不了（編號沒通過檢查就不送 AI）
    AS->>AI: buildPrompt（規則＋申請內容標籤）；呼叫時不鎖
    AI-->>AS: JSON
    AS->>AS: checkAI（白名單、AI 不能單獨放行）
  end
  AS->>AS: finalize（欄位一致、附件類型核對）
  AS->>SH: 取得鎖 → sanitizeCell 後寫入 9 個 AI 欄位（含規則版本）
  AS->>SH: rebuildDashboard → 回覆資料、到場預測
  書記官->>C: 打開儀表板（每 20 秒自動更新）
  C->>AS: GET …/exec?token=存取碼
  AS-->>C: JSON（已分類的結果）
  C->>書記官: KPI、待審清單、需人工確認、書記官待辦
  書記官->>書記官: 補件、電話確認，送法官決定
```

---

## 3. 免除申請怎麼判（兩層初篩）

```mermaid
flowchart TD
  A["一筆申請免除<br/>勾選的事由＋具體情況說明"] --> B{"說明是空的、<br/>含疑似指令文字、<br/>或說法模糊／反悔？"}
  B -->|是| AI
  B -->|否| C{"本人寫法的年齡 ≥ 70？<br/>（「我今年 72 歲」算；<br/>「她 85 歲」「家母 85 歲」不算）"}
  C -->|是| R1["得拒絕・第16條第1款"]
  C -->|"勾 70 但未滿"| R0["看起來不符合<br/>需人工確認"]
  C -->|"年次換算剛好 70"| AI
  C -->|沒寫| G{"自述曾任國民法官？<br/>（不是家人）"}
  G -->|是| R4["得拒絕・第16條第9款<br/>請調閱紀錄"]
  G -->|否| D{"提到別人，<br/>或退休、畢業、以前？"}
  D -->|是| AI
  D -->|否| E{"「我是／就讀」＋學校身分？<br/>（補習班、社區大學不算）"}
  E -->|是| R2["得拒絕・第16條第2、3款"]
  E -->|否| F{"「我是警察」「我在地檢署當書記官」？<br/>（職業後面就結束；排除助理、外包、國民法官）"}
  F -->|是| R3["不得擔任・第14條"]
  F -->|否| AI

  AI["AI：buildPrompt → Gemini → checkAI<br/>類型／AI建議不在白名單 → 保守值＋格式異常"]

  R1 & R2 & R3 --> P{"說明有寫附件？"}
  P -->|有| OK["核對附件後送法官<br/>（書記官看過實際文件後打勾）"]
  P -->|沒有| NEED["需人工確認：請補證明"]
  AI --> H{"AI 說可能符合＋不需確認，<br/>而且有附件、沒有可疑文字？"}
  H -->|是| OK
  H -->|否| NEED

  OK & NEED & R0 & R4 --> Z["finalize：附件類型和事由對不上 → 需人工確認<br/>結果只是初步整理，是否准許由法官決定"]
```

規則層採白名單：只有本人寫法才判，其他一律交給 AI＋人工。每條規則都有測試案例（`tests/fixtures/exemptions.json`），`npm run eval` 會算出覆蓋率與正確率。
附件只是民眾在說明裡寫的字，所以不論哪一層，最好的結果都是「核對附件後送法官」，不會出現「可直接送法官」。

---

## 4. 問答小幫手怎麼回答

```mermaid
flowchart TD
  Q["民眾輸入問題"] --> A{"閒聊？<br/>你好、你是誰、謝謝"}
  A -->|是| A1["固定回覆"]
  A -->|否| B{"有 window.claude？<br/>（只有在 Claude 環境示範時）"}
  B -->|有| B1["LLM 依 KB 提示詞回答，附出處"]
  B -->|沒有| C{"語意模型載好了？"}
  C -->|是| C1["bge-small-zh 向量相似度<br/>＋ 0.08 × 關鍵字分數<br/>&lt; 0.6 沒有收錄；&lt; 0.72 加「不太確定」"]
  C -->|"否（下載中或失敗）"| D1["雙字詞重疊比對<br/>題目 2 分、答案 0.6 分"]
  C1 & D1 & B1 --> E{"牽涉個人狀況？<br/>免除、我是…、沒有收錄"}
  E -->|是| F["附上 PartyRock AI 導覽連結"]
  E -->|否| G["顯示答案與出處"]
```

資料庫：41 題司法院國民法官常見問答（Q3601–Q3641）＋ 20 題補充（A001–A020），內嵌在 `index.html` 的 `KB`；口語問法在 `ALT`、`MORE_ALT`。

---

## 5. 信任邊界與防護

```mermaid
flowchart LR
  U["民眾輸入<br/>（不可信）"] -->|"&lt;申請內容&gt; 標籤包起來<br/>clean() 去掉假標籤、限 1000 字"| LLM["AI"]
  LLM -->|"不可信輸出"| CK["checkAI<br/>列舉白名單、文字截斷<br/>AI 不能單獨放行"]
  CK --> FZ["finalize<br/>欄位一致、附件核對"]
  FZ -->|"sanitizeCell<br/>防公式注入"| SH[("試算表")]
  SH -->|"doGet 驗存取碼"| C["court.html"]
  C -->|"esc() 跳脫 HTML<br/>CSP：只跑本站程式"| 畫面
```

| 威脅 | 防護 | 位置 |
|---|---|---|
| 提示注入（「忽略以上規則…」） | 標籤包裝、`INJECT` 偵測、白名單、AI 不能單獨放行 | `lib/screening.js` |
| 公式注入（`=IMPORTDATA(…)`） | `sanitizeCell()` | `lib/screening.js`、`apps-script/main.gs` |
| XSS | `esc()`、CSP `script-src 'self'`（`connect-src` 允許的 Google 網域任何人都能架服務，擋不住注入後的外送，所以重點是不讓程式注入） | `court.js`、`court.html` |
| 試算表外流 | 網頁應用程式＋存取碼，試算表不公開 | `doGet()` |
| 金鑰外流 | 金鑰放 Apps Script 指令碼屬性；瀏覽器預設只存 sessionStorage | `main.gs`、`court.js` |
| 存取碼外流（讀得到全部說明） | 只存在這個分頁（sessionStorage），不提供「記住」 | `court.js` |
| AI 摘要算錯、多送資料 | 摘要由程式產生（`summarize`），不呼叫 AI | `lib/screening.js` |
| 同時寫入 | `LockService`，只鎖新增標題、寫入、重建儀表板（呼叫 AI 時不鎖，同時送出的人不會等到逾時） | `withLock_()` |
| 假資料耗掉 AI 額度 | 編號格式異常、不在通知名冊、已被同一人後來的回覆取代的，不送 AI | `classifyRow_()` |
| 前後端規則版本不同 | 試算表記錄每列的規則版本；court.html 發現版本不同會警告；舊版規則判的列可一鍵重判 | `main.gs`、`court.js` |
| 健康資料留在網址 | 說明不進預填網址，改複製貼上 | `index.html` |

---

## 6. 程式碼結構

```mermaid
flowchart TB
  subgraph 共用純函式["lib/（純函式，有單元測試）"]
    SC["screening.js<br/>RULES_PROMPT · ruleClassify · checkAI<br/>finalize · summarize · sanitizeCell · normalizeReply"]
    QA["qa-search.js<br/>parseEntries · keywordAnswer<br/>hybridAnswer · chatReply"]
  end
  IDX["index.html<br/>劇本、像素繪圖、音效、手機介面"] --> QA
  CJ["court.js<br/>讀資料、快取、畫面"] --> SC
  CH["court.html<br/>版面＋CSP"] --> CJ
  MG["apps-script/main.gs<br/>觸發、讀寫試算表、doGet、Gemini"] --> SC
  BG["scripts/build-gs.mjs"] -->|合併| CODE["apps-script/Code.gs<br/>（貼進 Apps Script 的檔案）"]
  MG --> BG
  SC --> BG
  T["tests/*.test.js"] --> SC & QA & CODE
```

```
juror-preview/
├── index.html              民眾端：像素遊戲＋問答小幫手
├── court.html              法院端：儀表板版面與 CSP
├── court.js                法院端：程式
├── lib/
│   ├── screening.js        免除初篩（court.html 與 Apps Script 共用）
│   └── qa-search.js        問答比對
├── apps-script/
│   ├── main.gs             Apps Script 原始碼
│   └── Code.gs             自動產生，貼進 Apps Script 的就是這個
├── prompts/                PartyRock 提示詞（模組 2、3、5、6）
├── scripts/build-gs.mjs    產生 Code.gs
├── tests/                  單元測試、標註資料、準確度評估
└── docs/                   說明文件（本資料夾）
```

---

## 7. 部署與更新

| 改了什麼 | 要做什麼 |
|---|---|
| `index.html`、`court.html`、`court.js`、`lib/*` | 合併到 `main` 後 GitHub Pages 自動更新（約 1 分鐘） |
| `lib/screening.js` 或 `apps-script/main.gs` | `npm run build:gs` → 把 `apps-script/Code.gs` 全部貼進 Apps Script → 儲存。若有用網頁應用程式：「部署 → 管理部署作業 → 編輯 → 新版本」 |
| `RULES_PROMPT`（事由清單或規則） | 同上，另外手動同步 `prompts/` 和 PartyRock 模組 3、6 |
| 問答資料庫（`KB`） | 改 `index.html`，同步 `prompts/PartyRock問答提示詞.txt` 與 PartyRock，跑 `npm test` |

詳細設定步驟見 [SETUP.md](SETUP.md)；欄位格式見 [DATA_SCHEMA.md](DATA_SCHEMA.md)。

---

## 8. 導入路徑：哪些是示範外殼，哪些能帶走

原型用 Google 表單、試算表、Apps Script、GitHub Pages 把流程串起來，方便 Demo。
法院不會把特種個資（健康說明）放在這些服務上，所以正式導入時，**要換掉的是整個資料層，不只是 AI 模型**。

| 元件 | 原型 | 正式版 | 能直接帶走？ |
|---|---|---|---|
| 初篩邏輯 `lib/screening.js` | court.html 與 Apps Script 共用 | 接進法院既有的選任系統（任何 JavaScript 環境；或照測試案例改寫成其他語言） | ✅ 純函式、JSON 進出，不碰 DOM 和 Google 服務 |
| 標註資料與評估 `tests/fixtures/`、`npm run eval` | 44 筆虛構案例 | 加入法院去識別化的真實案例，定期重跑 | ✅ |
| AI 模型 | Gemini 免費版 | 法院自建模型（例如 TAIDE） | 🟡 換 `callLLM_()`，但要用 `eval --ai` 重測 JSON 格式穩不穩定、準確度 |
| 收件 | Google 表單（示範替身） | 官方線上調查表 | ❌ |
| 資料儲存 | Google 試算表 | 法院系統 | ❌ |
| 法院端畫面 | GitHub Pages＋存取碼 | 法院內網＋法院帳號登入 | 🟡 畫面與欄位可參考，存取控制要換 |
| 到場預測 | 試算表公式＋假設值（履約率 0.9、未回覆 0.489、所需人數） | 依案號分組，用實際到場資料校正參數 | 🟡 公式可帶走，參數要重估 |
| 民眾端遊戲、問答小幫手 | GitHub Pages | 放上司法院網站（純靜態） | ✅ 語意模型建議自架（[REFACTORING.md](REFACTORING.md) R-4） |
| PartyRock 模組 2、3、5 | 需登入的第三方服務 | 換成法院的服務，或改成站內不用 AI 的版本 | ❌ |

接法與欄位格式見 [INTEGRATION.md](INTEGRATION.md)。最簡單的接法是「匯入表格檔」：官方系統匯出 CSV，在法院端儀表板匯入，資料只在本機用規則判，不必修改官方系統。

提案時的說法建議：「我們交付的是**可嵌入既有系統的初篩模組＋標註評估集＋民眾端預演**；Google 那一套是為了讓評審看到完整流程的示範外殼。」
