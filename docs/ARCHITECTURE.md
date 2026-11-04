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
    GH["index.html · court.html · court.js<br/>lib/screening.js · lib/qa-search.js · lib/self-help.js"]
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

  subgraph "Google（獨立的 Apps Script 專案）"
    PX["民眾端 AI 代理<br/>apps-script/PublicAI.gs<br/>限流・注入防護・預設關閉"]
  end

  PR["PartyRock<br/>模組 1、2、3、5、6<br/>（只給評審看）"]

  GH -->|載入| G
  GH -->|載入| C
  P -.->|首次使用下載| CDN
  P -.->|首次使用下載| HF
  G -->|試填一次：開啟預填網址| F
  P -.->|"AI 自由評議（只送對虛構案件說的話）"| PX
  PX -.-> GM
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
| 免除初篩、專屬準備清單（模組 3、2） | `index.html` + `lib/self-help.js` + `lib/screening.js` | 民眾的瀏覽器 | 民眾自己輸入，**不離開瀏覽器** |
| AI 自由評議（模組 5） | `apps-script/PublicAI.gs` | 獨立的 Google Apps Script → Gemini | 否。只談虛構案件；預設關閉 |
| 示範表單 | Google 表單 | Google | 是（只能用虛構資料） |
| 自動分類 | `apps-script/Code.gs`（= `apps-script/main.gs` + `lib/screening.js`） | Google Apps Script | 是 |
| AI 模型 | Gemini API（原型）／TAIDE（正式版） | Google／法院自建 | 是（只送規則判不了的那幾筆） |
| 法院端儀表板 | `court.html` + `court.js` + `lib/screening.js` | 書記官的瀏覽器 | 是 |
| 統計圖表 | Looker Studio | Google | 統計數字為主 |
| AI 工具箱（評審展示用） | PartyRock（模組 1、2、3、5、6） | AWS PartyRock | 不放在民眾端（要登入） |

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
  SH->>AS: onFormSubmit（取得鎖，同時送出會排隊）
  AS->>AS: Screening.ruleClassify（年齡、在學、法定職業、曾任）
  alt 規則判得了
    AS->>AS: 不花 token，判斷來源＝規則
  else 規則判不了
    AS->>AI: buildPrompt（規則＋申請內容標籤）
    AI-->>AS: JSON
    AS->>AS: checkAI（白名單、AI 不能單獨放行）
  end
  AS->>AS: finalize（欄位一致、附件類型核對）＋ 編號格式檢查
  AS->>SH: sanitizeCell 後寫入 8 個 AI 欄位
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
  B -->|否| C{"自己的年齡 ≥ 70？<br/>（跳過家人的歲數）"}
  C -->|是| R1["得拒絕・第16條第1款"]
  C -->|"勾 70 但未滿"| R0["看起來不符合<br/>需人工確認"]
  C -->|"年次換算剛好 70"| AI
  C -->|沒寫| D{"有提到家人朋友？"}
  D -->|是| AI
  D -->|否| E{"本人在學／任教？"}
  E -->|是| R2["得拒絕・第16條第2、3款"]
  E -->|否| F{"第14條列舉職業？<br/>（排除助理、退休、否定句、國民法官）"}
  F -->|是| R3["不得擔任・第14條"]
  F -->|否| G{"自述曾任國民法官？"}
  G -->|是| R4["得拒絕・第16條第9款<br/>請調閱紀錄"]
  G -->|否| AI

  AI["AI：buildPrompt → Gemini → checkAI<br/>類型／AI建議不在白名單 → 保守值＋格式異常"]

  R1 & R2 & R3 --> P{"說明有寫附件？"}
  P -->|有| OK["可直接送法官"]
  P -->|沒有| NEED["需人工確認：請補證明"]
  AI --> H{"AI 說可能符合＋不需確認，<br/>而且有附件、沒有可疑文字？"}
  H -->|是| OK
  H -->|否| NEED

  OK & NEED & R0 & R4 --> Z["finalize：附件類型和事由對不上 → 需人工確認<br/>結果只是初步整理，是否准許由法官決定"]
```

規則層的判斷都有測試案例（`tests/fixtures/exemptions.json`），`npm run eval` 會算出覆蓋率與正確率。

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
  E -->|是| F["附上免登入小工具：免除初篩、專屬準備清單"]
  E -->|否| G["顯示答案與出處"]
```

資料庫：41 題司法院國民法官常見問答（Q3601–Q3641）＋ 20 題補充（A001–A020），內嵌在 `index.html` 的 `KB`；口語問法在 `ALT`、`MORE_ALT`。

---

## 4-1. 民眾不用登入：每個 AI 功能在哪裡跑

以前民眾端的模組 2、3、5 都要另開 PartyRock，而 PartyRock 要先登入 AWS 帳號，收到通知的民眾不會為了這個去註冊。現在依「會不會碰到個資」分兩種做法：

| 功能 | 做法 | 為什麼 |
|---|---|---|
| 問答小幫手（模組 1） | 瀏覽器內語意搜尋（已經是這樣） | 只回資料庫原文，不會幻覺 |
| 免除初篩＋說明草稿（模組 3） | 瀏覽器內：`Screening.ruleClassify`（和法院端同一套規則）＋ `SelfHelp.checkSituation` 關鍵字分類（第 16 條第 4、6、7、8、10 款） | 民眾會寫病名、家人狀況（個資法第 6 條的敏感資料），不送到任何伺服器；草稿只把民眾自己寫的內容套進固定格式 |
| 專屬準備清單（模組 2） | 瀏覽器內：選身分、勾擔心的事 → `SelfHelp.buildGuide` 挑出常見問答原文 | 只引用原文，不產生新文字 |
| AI 自由評議（模組 5） | `apps-script/PublicAI.gs` 代理 Gemini；`index.html` 的 `AI_PROXY` 空白時不顯示 | 真的需要生成式 AI；只談虛構案件，不碰個資 |

```mermaid
sequenceDiagram
  autonumber
  actor 民眾
  participant G as index.html（手機）
  participant PX as PublicAI.gs（獨立 Apps Script）
  participant AI as Gemini
  G->>PX: GET（遊戲載入時）
  PX-->>G: {"on":true}（PUBLIC_AI=on 且有金鑰）
  民眾->>G: 第 7 關選「和 AI 法官自由討論」，輸入一句話
  G->>PX: POST text/plain {"kind":"delib","sid":隨機代號,"text":"…"}
  PX->>PX: 檢查格式、≤300 字、疑似指令文字 → 固定回覆
  PX->>PX: 全站限流（每分鐘、每天）、每場 ≤16 回合
  PX->>AI: systemInstruction＝伺服器端的評議提示詞<br/>contents＝伺服器快取裡的前文＋這一句
  AI-->>PX: 回覆
  PX-->>G: {"reply":"…","left":剩餘回合}
  Note over G,PX: 代理關閉、額度用完或出錯 → 遊戲照劇本評議
```

設計重點：金鑰只在指令碼屬性；提示詞和對話紀錄都在伺服器端，民眾只能送「自己說的一句話」，所以不能把它變成任人使用的免費 AI，也不能偽造 AI 說過的話。代理放在**獨立**的 Apps Script 專案，碰不到法院端試算表。

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
| XSS | `esc()`、CSP `script-src 'self'` | `court.js`、`court.html` |
| 試算表外流 | 網頁應用程式＋存取碼，試算表不公開 | `doGet()` |
| 金鑰外流 | 金鑰放 Apps Script 指令碼屬性；瀏覽器預設只存 sessionStorage | `main.gs`、`court.js` |
| 同時寫入 | `LockService` | `withLock_()` |
| 健康資料留在網址 | 說明不進預填網址，改複製貼上 | `index.html` |

---

## 6. 程式碼結構

```mermaid
flowchart TB
  subgraph 共用純函式["lib/（純函式，有單元測試）"]
    SC["screening.js<br/>RULES_PROMPT · ruleClassify · checkAI<br/>finalize · sanitizeCell · normalizeReply"]
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
│   ├── qa-search.js        問答比對
│   └── self-help.js        民眾端免除初篩、專屬準備清單（取代 PartyRock 模組 2、3）
├── apps-script/
│   ├── main.gs             法院端 Apps Script 原始碼（模組 6）
│   ├── Code.gs             自動產生，貼進法院端 Apps Script 的就是這個
│   ├── public-ai.gs        民眾端 AI 代理原始碼（模組 5 自由評議）
│   └── PublicAI.gs         自動產生，貼進「另一個獨立」Apps Script 專案
├── prompts/                PartyRock 提示詞（模組 2、3、5、6）
├── scripts/build-gs.mjs    產生 Code.gs、PublicAI.gs
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
| 評議提示詞（`index.html` 的 `DELIB`） | `npm run build:gs` → 把 `apps-script/PublicAI.gs` 貼進民眾端 AI 代理 → 部署新版本；同步 PartyRock 模組 5 |
| 問答資料庫（`KB`） | 改 `index.html`，同步 `prompts/PartyRock問答提示詞.txt` 與 PartyRock，跑 `npm test` |

詳細設定步驟見 [SETUP.md](SETUP.md)；欄位格式見 [DATA_SCHEMA.md](DATA_SCHEMA.md)。
