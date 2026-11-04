/**
 * 模組 6｜免除申請自動分類（Google 表單 → 試算表 → Apps Script → 規則＋Gemini）
 * =======================================================================
 *
 * ⚠ 這是原始碼。請不要直接貼這個檔案：
 *   貼進 Apps Script 的是 apps-script/Code.gs（npm run build:gs 產生，已含 lib/screening.js）。
 *
 * 民眾送出 Google 表單後：
 *   1. onFormSubmit 讀取那一列；同一人後來又送出、或不是「申請免除」就標記略過
 *   2. 先檢查編號格式與通知名冊，再用 Screening.ruleClassify 規則判（都不花 token）；
 *      判不了、而且編號通過檢查，才呼叫 Gemini（呼叫時不鎖，避免同時送出的人拿不到鎖）
 *   3. Gemini 回傳經 Screening.checkAI 檢查白名單，再經 Screening.finalize 核對附件
 *   4. 結果寫在同一列右邊的 AI 欄位（寫入前經 Screening.sanitizeCell 防公式注入）
 *   5. 重建「回覆資料」「到場預測」兩個工作表，格式和模組 4 相同，Looker Studio 直接連
 *
 * 法院端儀表板 court.html 透過 doGet（部署成網頁應用程式＋存取碼）讀取結果，
 * 試算表本身不必再設成「知道連結的人可檢視」。
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   GEMINI_API_KEY   必填。AI Studio 申請的金鑰
 *   GEMINI_MODEL     選填。預設 gemini-2.5-flash
 *   DASHBOARD_TOKEN  選填。court.html 讀資料用的存取碼（建議 20 字以上亂碼）；沒設就不開放讀取
 *   NEEDED_PER_CASE  選填。到場預測的「選任所需人數」，由法院依個案設定（沒設暫用 57）
 *
 * ⚠ 免費版 Gemini API 的資料可能被 Google 用來改進模型：Demo 只能用虛構資料。
 * 換模型（例如法院自建的 TAIDE）只要改 callLLM_()；但正式上線時資料不會放在 Google 試算表，
 * 這個檔案是示範用的外殼，能帶走的是 lib/screening.js（見 docs/ARCHITECTURE.md「導入路徑」）。
 */

/** @OnlyCurrentDoc */ // 只要求「這一份試算表」的權限，避免 Google 擋下授權

/* ---------- 設定 ---------- */

/**
 * 表單題目 → 欄位。先用標題文字找（題目順序改了也不怕），找不到才用預設欄位。
 * 預設：A 時間戳記，B 候選人編號，C 你的回覆，D 勾選的事由，E 具體情況說明。
 */
const FIELDS = {
  id:      { re: /候選人編號|編號/, fallback: 2 },
  reply:   { re: /你的回覆|回覆/,   fallback: 3 },
  reasons: { re: /事由/,            fallback: 4 },
  note:    { re: /說明/,            fallback: 5 },
};
/** AI 寫入的欄位（不存在就自動加在最右邊）。只能在最後面新增，不要改順序。 */
const AI_COLS = ['AI 對應事由', 'AI 類型', 'AI 建議', '需人工確認', 'AI 理由', '書記官待辦', 'AI 處理時間', '判斷來源', '規則版本'];
const DEFAULT_MODEL = 'gemini-2.5-flash';
/** Apps Script 單次執行上限 6 分鐘；留 1 分鐘緩衝，超過就先停，請使用者再按一次。 */
const TIME_BUDGET_MS = 5 * 60 * 1000;
/** 免費額度每分鐘有次數上限，每筆 AI 呼叫之間的間隔。 */
const AI_GAP_MS = 4500;
/** 模組 4 的工作表名稱與假設值（和《模組4_法院儀表板模擬資料.xlsx》一致）。 */
const DASH = { roster: '通知名冊', replies: '回覆資料', forecast: '到場預測', summary: '書記官摘要', showRate: 0.9, baseRate: 0.489, needed: 57 };

/* ---------- 觸發與選單 ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🤖 AI 免除分類')
    .addItem('分類所有尚未處理的申請', 'classifyPending')
    .addItem('產生書記官摘要', 'writeSummary')
    .addItem('重建儀表板資料（回覆資料／到場預測）', 'rebuildDashboard')
    .addSeparator()
    .addItem('測試 API 金鑰', 'testKey')
    .addToUi();
}

/**
 * 觸發條件：「試算表 → 提交表單時」。
 * 鎖只包住「新增欄位標題、寫入、重建儀表板」這幾個很快的步驟，呼叫 Gemini 時不鎖。
 * 以前整段都鎖著：一筆 AI 遇到 429 要等上近一分鐘，同時送出的其他人等 30 秒拿不到鎖就失敗，那幾筆不會被分類。
 */
function onFormSubmit(e) {
  classifyRow_(e.range.getSheet(), e.range.getRow());
  withLock_(rebuildDashboard);
}

/**
 * 選單：補跑還沒處理完的列，接近 6 分鐘上限時會先停。
 *   - 還沒有「AI 處理時間」的（觸發失敗、AI 失敗）
 *   - 舊版規則判的（lib/screening.js 的規則改了：用新規則重判，規則判不了的改交 AI）
 */
function classifyPending() {
  const started = Date.now();
  const sheet = responseSheet_();
  const cols = withLock_(() => cols_(sheet));
  const data = sheet.getDataRange().getValues();
  const ctx = context_(cols, data);
  let n = 0, redo = 0, left = 0;
  for (let r = 2; r <= data.length; r++) {
    const row = data[r - 1];
    const stale = row[cols.ai['判斷來源'] - 1] === '規則' && row[cols.ai['規則版本'] - 1] !== Screening.RULES_VERSION;
    if (row[cols.ai['AI 處理時間'] - 1] !== '' && !stale) continue;
    if (Date.now() - started > TIME_BUDGET_MS) { left++; continue; }
    const res = classifyRow_(sheet, r, ctx);
    if (res.counted) { n++; if (stale) redo++; }
    if (res.usedAI) Utilities.sleep(AI_GAP_MS);
  }
  withLock_(rebuildDashboard);
  const done = `共處理 ${n} 筆申請免除` + (redo ? `（其中 ${redo} 筆是舊版規則判的，已用新規則重判）` : '');
  SpreadsheetApp.getActive().toast(left ? `${done}，還有 ${left} 筆，請再按一次。` : `完成，${done}。`, 'AI 免除分類');
}

/* ---------- 分類一列 ---------- */

/**
 * 一次讀好的檢查資料：每個編號最後一次送出在哪一列；通知名冊（有建立的話）。
 * @returns {{latest:Object<string,number>, roster:Set<string>|null}}
 */
function context_(cols, data) {
  const latest = {};
  data.slice(1).forEach((r, i) => { const id = String(r[cols.id - 1]).trim(); if (id) latest[id] = i + 2; });
  const sh = SpreadsheetApp.getActive().getSheetByName(DASH.roster);
  const roster = sh ? new Set(sh.getDataRange().getValues().slice(1).map(r => String(r[0]).trim()).filter(Boolean)) : null;
  return { latest, roster };
}

/**
 * 分類試算表的一列並寫回 AI 欄位。順序是「先檢查（不花 token）→ 規則 → AI」：
 *   1. 同一人後來又送出 → 以後來的為準，這筆不分類（和 rebuildDashboard、court.html 一致）
 *   2. 不是「申請免除」→ 標記略過
 *   3. 編號格式異常或不在通知名冊 → 規則判得了照判，判不了也不送 AI（避免假資料耗掉額度），一律人工確認
 *   4. 規則判不了 → AI（呼叫時不鎖）
 * @param {object} [ctx]  context_() 的結果；沒給就現讀（onFormSubmit）
 * @returns {{counted:boolean, usedAI:boolean}}
 */
function classifyRow_(sheet, row, ctx) {
  const cols = withLock_(() => cols_(sheet)); // 可能要新增欄位標題：鎖著，避免兩筆同時送出時新增兩組
  ctx = ctx || context_(cols, sheet.getDataRange().getValues());
  const app = readApp_(sheet, row, cols);
  const stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  const skip = label => { withLock_(() => writeAI_(sheet, row, cols, { 'AI建議': label }, stamp, '')); return { counted: false, usedAI: false }; };
  if (app.id && ctx.latest[app.id] && ctx.latest[app.id] !== row) return skip('（同一人後來又送出，以最後一次為準）');
  if (Screening.normalizeReply(app.reply) !== '申請免除') return skip('（非免除申請，不需分類）');

  const problem = !Screening.isPlausibleId(app.id) ? '候選人編號格式異常，請核對名冊'
    : ctx.roster && !ctx.roster.has(app.id) ? '候選人編號不在通知名冊，請核對' : '';
  let out = Screening.ruleClassify(app);
  let usedAI = false;
  if (!out && problem) {
    out = { '對應事由': '—', '類型': '—', 'AI建議': '資料不足', '需人工確認': '是', '理由': '編號未通過檢查，未送 AI', '書記官待辦': problem, src: 'rule' };
  } else if (!out) {
    usedAI = true;
    try {
      out = Screening.checkAI(Screening.parseJson(callLLM_(Screening.buildPrompt(app))), app);
    } catch (err) {
      out = Screening.pendingResult('AI 失敗：' + String(err.message).slice(0, 60));
    }
  }
  out = Screening.finalize(out, app);
  if (problem) out = Object.assign({}, out, { '需人工確認': '是', '書記官待辦': problem });
  // AI 失敗（pending）不寫處理時間，下次「分類所有尚未處理的申請」會再試
  const source = { rule: '規則', ai: 'AI', pending: '待人工' }[out.src] || '';
  withLock_(() => writeAI_(sheet, row, cols, out, out.src === 'pending' ? '' : stamp, source));
  return { counted: true, usedAI };
}

function readApp_(sheet, row, cols) {
  const get = c => (c ? String(sheet.getRange(row, c).getValue()).trim() : '');
  return { id: get(cols.id), reply: get(cols.reply), reasons: get(cols.reasons), note: get(cols.note) };
}

/** 逐欄寫入（不假設 AI 欄位相鄰），每個值都先防公式注入。 */
function writeAI_(sheet, row, cols, out, stamp, source) {
  const vals = {
    'AI 對應事由': out['對應事由'], 'AI 類型': out['類型'], 'AI 建議': out['AI建議'], '需人工確認': out['需人工確認'],
    'AI 理由': out['理由'], '書記官待辦': out['書記官待辦'], 'AI 處理時間': stamp, '判斷來源': source,
    '規則版本': Screening.RULES_VERSION,
  };
  AI_COLS.forEach(k => sheet.getRange(row, cols.ai[k]).setValue(Screening.sanitizeCell(vals[k] || '')));
  if (out['需人工確認'] === '是') sheet.getRange(row, cols.ai['需人工確認']).setBackground('#fde2b8');
}

/* ---------- 法院端儀表板讀取（網頁應用程式） ---------- */

/**
 * 部署 → 新增部署作業 → 網頁應用程式；執行身分「我」、存取權「任何人」。
 * court.html 以 ?token=存取碼 讀取。存取碼錯誤或未設定，一律回傳錯誤、不給資料。
 * 回傳的是已分類的結果，court.html 不需要自己的 Gemini 金鑰。
 */
function doGet(e) {
  const token = PropertiesService.getScriptProperties().getProperty('DASHBOARD_TOKEN');
  const given = e && e.parameter ? String(e.parameter.token || '') : '';
  if (!token || given !== token) return json_({ ok: false, error: '存取碼錯誤或尚未設定 DASHBOARD_TOKEN' });
  const sheet = responseSheet_();
  const cols = cols_(sheet);
  const data = sheet.getDataRange().getValues().slice(1);
  const rows = data.filter(r => r[cols.id - 1] || r[cols.reply - 1]).map(r => {
    const ai = {};
    AI_COLS.forEach(k => (ai[k] = r[cols.ai[k] - 1]));
    const ts = r[0] instanceof Date ? Utilities.formatDate(r[0], 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss') : String(r[0]);
    return { ts, id: String(r[cols.id - 1]), reply: String(r[cols.reply - 1]), reasons: String(r[cols.reasons - 1]), note: String(r[cols.note - 1]), ai };
  });
  return json_({ ok: true, rulesVersion: Screening.RULES_VERSION, generatedAt: new Date().toISOString(), rows });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 模組 4 儀表板資料（Looker Studio 的資料來源） ---------- */

/**
 * 依模組 4 的格式重建「回覆資料」和「到場預測」：
 *   回覆資料：候選人編號｜案號｜通知寄出日｜回覆狀態｜回覆日期｜是否使用AI導覽｜免除事由（AI初篩）｜提問內容｜提問分類
 *   - 有「通知名冊」工作表（候選人編號｜案號｜通知寄出日）：以名冊為準，沒回覆的標「未回覆」
 *   - 沒有名冊：只列出有回覆的人
 *   - 同一人回覆多次，以最後一次為準
 *   - 是否使用AI導覽、提問內容、提問分類：表單沒有收集，留空（見 docs/DATA_SCHEMA.md）
 */
function rebuildDashboard() {
  const ss = SpreadsheetApp.getActive();
  const sheet = responseSheet_();
  const cols = cols_(sheet);
  const latest = {};
  sheet.getDataRange().getValues().slice(1).forEach(r => {
    const id = String(r[cols.id - 1]).trim();
    if (id) latest[id] = r;
  });
  const roster = ss.getSheetByName(DASH.roster);
  const base = roster
    ? roster.getDataRange().getValues().slice(1).filter(r => r[0]).map(r => [String(r[0]).trim(), r[1], r[2]])
    : Object.keys(latest).map(id => [id, '', '']);
  const header = ['候選人編號', '案號', '通知寄出日', '回覆狀態', '回覆日期', '是否使用AI導覽', '免除事由（AI初篩）', '提問內容', '提問分類'];
  const out = base.map(([id, caseNo, sent]) => {
    const r = latest[id];
    const status = r ? Screening.normalizeReply(r[cols.reply - 1]) || '未回覆' : '未回覆';
    const reason = r && status === '申請免除' ? r[cols.ai['AI 對應事由'] - 1] : '';
    return [id, caseNo, sent, status, r ? r[0] : '', '', reason, '', ''].map(Screening.sanitizeCell);
  });
  const rep = ss.getSheetByName(DASH.replies) || ss.insertSheet(DASH.replies);
  rep.clearContents();
  rep.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (out.length) rep.getRange(2, 1, out.length, header.length).setValues(out);

  const n = Math.max(out.length + 1, 2), D = `回覆資料!D2:D${n}`;
  // 選任所需人數要由法院依個案設定；名冊有好幾個案號時，下面是合計，不是個案預測
  const neededProp = Number(PropertiesService.getScriptProperties().getProperty('NEEDED_PER_CASE'));
  const cases = new Set(base.map(r => String(r[1] || '').trim()).filter(Boolean)).size;
  const fc = ss.getSheetByName(DASH.forecast) || ss.insertSheet(DASH.forecast);
  fc.clearContents();
  fc.getRange(1, 1, 12, 3).setValues([
    ['項目', '數值', '說明'],
    ['通知人數', `=COUNTA(回覆資料!A2:A${n})`, !roster ? '尚未建立「通知名冊」，只計有回覆的人' : cases > 1 ? `名冊有 ${cases} 個案號，以下是合計，不是個案預測（個案請在 Looker Studio 依案號篩選）` : '通知名冊的人數'],
    ['回覆會到場', `=COUNTIF(${D},"會到場")`, ''],
    ['申請免除', `=COUNTIF(${D},"申請免除")`, '交由法院審查，預測時不計入到場'],
    ['未回覆', `=COUNTIF(${D},"未回覆")`, ''],
    ['尚未決定', `=COUNTIF(${D},"尚未決定")`, '有回覆但還沒決定，預測時比照未回覆'],
    ['回覆率', '=IFERROR((B3+B4+B6)/B2,0)', '有回覆的比例'],
    ['回覆會到場者的實際到場率（假設）', DASH.showRate, '假設值，正式上線後用實際資料校正'],
    ['未回覆者的到場率（假設）', DASH.baseRate, '沿用113年整體到場率48.9%（司法院）。沒回覆的人實際到場率可能更低，上線後要用實際資料校正'],
    ['預測到場人數', '=ROUND(B3*B8+(B5+B6)*B9,0)', '回覆會到場×履約率 +（未回覆＋尚未決定）×歷史到場率'],
    ['選任所需人數（假設）', neededProp || DASH.needed, neededProp ? '指令碼屬性 NEEDED_PER_CASE' : '暫用113年平均每案到場人數（約57人），這不是需求人數。請依國民法官6人、備位人數與預估拒卻人數，設定指令碼屬性 NEEDED_PER_CASE'],
    ['預測是否足額', '=IF(B10>=B11,"足額","不足，建議追加通知")', ''],
  ]);
}

/* ---------- 書記官摘要（純程式，不用 AI） ---------- */

/**
 * 選單「產生書記官摘要」：由 Screening.summarize 統計筆數與編號。
 * 以前請 Gemini 寫，會把所有申請（包含規則已經判掉的）送出去，還可能算錯筆數；現在不呼叫任何 API。
 * 同一位候選人送出多次，以最後一次為準（和 rebuildDashboard 一致）。
 */
function writeSummary() {
  const sheet = responseSheet_();
  const cols = cols_(sheet);
  const latest = {};
  sheet.getDataRange().getValues().slice(1).forEach((r, i) => {
    const id = String(r[cols.id - 1]).trim();
    latest[id || '#' + i] = r;
  });
  const items = Object.keys(latest).map(k => latest[k])
    .filter(r => Screening.normalizeReply(r[cols.reply - 1]) === '申請免除')
    .map(r => ({
      id: String(r[cols.id - 1]),
      c: r[cols.ai['AI 處理時間'] - 1] === ''
        ? Screening.pendingResult('尚未分類，請按「分類所有尚未處理的申請」')
        : { 'AI建議': r[cols.ai['AI 建議'] - 1], '需人工確認': r[cols.ai['需人工確認'] - 1], '書記官待辦': r[cols.ai['書記官待辦'] - 1] },
    }));
  if (!items.length) { SpreadsheetApp.getUi().alert('目前沒有免除申請。'); return; }
  const text = Screening.summarize(items);
  const ss = SpreadsheetApp.getActive();
  const out = ss.getSheetByName(DASH.summary) || ss.insertSheet(DASH.summary);
  out.insertRowBefore(1);
  out.getRange(1, 1, 1, 2).setValues([[Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm'), Screening.sanitizeCell(text)]]);
  out.getRange(1, 2).setWrap(true);
  out.setColumnWidth(2, 600);
  ss.setActiveSheet(out);
}

/* ---------- 呼叫 Gemini（正式版換成法院自建模型時，只改這個函式） ---------- */

/**
 * @param {string} prompt
 * @param {boolean} [json=true]  要求模型只回 JSON
 * @returns {string} 模型回覆文字
 */
function callLLM_(prompt, json = true) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('尚未設定 GEMINI_API_KEY（專案設定 → 指令碼屬性）');
  const model = encodeURIComponent(props.getProperty('GEMINI_MODEL') || DEFAULT_MODEL);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: Object.assign({ temperature: 0.1 }, json ? { responseMimeType: 'application/json' } : {}),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 429 || code >= 500) { Utilities.sleep(8000 * (attempt + 1)); continue; }
    const j = JSON.parse(res.getContentText());
    if (code !== 200) throw new Error(`HTTP ${code} ${j.error ? j.error.message : ''}`);
    const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    if (!parts) throw new Error('模型沒有回傳內容');
    return parts.map(p => p.text || '').join('');
  }
  throw new Error('API 忙碌中（超過免費額度），請稍後再試');
}

function testKey() {
  const t = callLLM_('請只回覆「金鑰可以用」五個字。', false);
  SpreadsheetApp.getUi().alert('Gemini 回覆：' + t);
}

/* ---------- 工具 ---------- */

/** 同一時間只讓一個執行（表單同時送出、手動補跑與觸發重疊時）。最多等 30 秒。 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function responseSheet_() {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheets().find(s => /表單回應|Form Responses/.test(s.getName())) || ss.getSheets()[0];
}

/** 找出表單題目與 AI 欄位的位置（1 起算）；AI 欄位不存在就加在最右邊。 */
function cols_(sheet) {
  let head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const missing = AI_COLS.filter(k => !head.includes(k));
  if (missing.length) {
    sheet.getRange(1, head.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground('#d9e8fb');
    head = head.concat(missing);
  }
  const ai = {};
  AI_COLS.forEach(k => (ai[k] = head.indexOf(k) + 1));
  const out = { ai };
  Object.keys(FIELDS).forEach(k => {
    const i = head.findIndex((h, idx) => idx > 0 && !AI_COLS.includes(h) && FIELDS[k].re.test(h) && !Object.values(out).includes(idx + 1));
    out[k] = i >= 0 ? i + 1 : FIELDS[k].fallback;
  });
  return out;
}
