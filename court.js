/**
 * court.js：法院端儀表板（court.html）的程式
 * ============================================
 *
 * 承辦人員每天打開的工作頁：讀取民眾的回覆，統計出席，並列出免除申請的初篩結果。
 * 初篩邏輯在 lib/screening.js（和 Apps Script 共用），這裡只負責讀資料、快取和畫面。
 *
 * 資料來源：
 *   - 匯入表格檔（「匯入表格檔」按鈕）：官方系統匯出的 CSV。只在這台電腦處理、不上傳，也不送 AI（只用規則判）。
 *     這是不必改官方系統、也不必知道它內部怎麼做的導入方式（docs/INTEGRATION.md）。
 * 設定裡的資料來源（二選一）：
 *   - Apps Script 網頁應用程式（建議）：試算表維持私人，court.html 用存取碼讀「已分類」的結果，
 *     不需要在瀏覽器放 Gemini 金鑰。
 *   - 公開試算表 CSV（舊做法）：試算表要設成「知道連結的人可檢視」，只能放虛構資料。
 *   - 示範資料：內建 17 筆虛構免除申請。
 *
 * 一列資料的格式（三種來源都轉成這個樣子）：
 *   { ts, id, reply, reasons, note, ai? }
 *   ai 是 Apps Script 寫好的分類結果（只有網頁應用程式模式才有）
 *
 * 存在瀏覽器的東西：
 *   - 存取碼、Gemini 金鑰：只存在這個分頁（sessionStorage），關掉就忘記；金鑰勾「記住」才存到 localStorage。
 *     存取碼讀得到全部人的健康說明，而 GitHub Pages 同網域的其他頁面也讀得到 localStorage，所以不提供「記住」。
 *   - 設定（網址、來源）、分類快取、「附件已核對」的勾選：localStorage。
 */
(function () {
  'use strict';
  var S = window.Screening;

  /* ---------- 示範資料：和《模組4_法院儀表板模擬資料.xlsx》的「免除申請」相同，另加到場與尚未決定的回覆 ---------- */
  var DEMO = (function () {
    var ex = [['C007', '具有老師或學生身分', '我目前是○○大學法律系三年級學生，平日要上課，期中考在 12 月。（附學生證影本）'],
      ['C023', '有重大疾病、傷害或身心因素', '上個月剛做完心臟手術，醫師說三個月內要多休息，不適合久坐或長時間外出。'],
      ['C037', '職業或身分不能擔任（如法官、檢察官、律師、警察、軍人）', '本人為現役警察，任職於○○分局。（附服務證明）'],
      ['C046', '有重大疾病、傷害或身心因素', '身體不好，常常不舒服。'],
      ['C055', '年滿 70 歲以上', '我今年 72 歲。（附身分證影本）'],
      ['C056', '年滿 70 歲以上', '本人民國 45 年次，已滿七十歲，膝蓋不好行動不便。（附身分證影本）'],
      ['C057', '其他（請在說明欄寫明）', '年紀大了不想去。'],
      ['C072', '職業或身分不能擔任（如法官、檢察官、律師、警察、軍人）', '我是國防部的文職人員。'],
      ['C075', '職業或身分不能擔任（如法官、檢察官、律師、警察、軍人）', '我在保全公司當保全員，算是維護治安的工作。（附在職證明）'],
      ['C085', '年滿 70 歲以上', '我 70 歲，但身體還很好，其實可以去，只是想問能不能不去。（附身分證影本）'],
      ['C090', '要照顧家人或養育小孩，執行職務有困難', '家裡有一個 2 歲小孩，先生長期在外地工作，白天沒有人可以照顧。（附戶口名簿影本）'],
      ['C091', '要照顧家人或養育小孩，執行職務有困難', '要照顧中風臥床的父親，家裡只有我一個人。'],
      ['C107', '年滿 70 歲以上', '我已經 75 歲，而且住在離島，交通很不方便。（附身分證影本）'],
      ['C123', '年滿 70 歲以上', '今年 71 歲。'],
      ['C139', '其他（請在說明欄寫明）', '我是夜市攤販，去法院那幾天沒辦法擺攤，收入會受影響。'],
      ['C150', '職業或身分不能擔任（如法官、檢察官、律師、警察、軍人）', '我在地檢署當書記官。（附服務證明）'],
      ['C161', '有重大疾病、傷害或身心因素', '上個月腰椎開刀，目前每週復健三次，久坐會痛。（附戶口名簿影本）']];
    var rows = [], n = 0;
    var pad = function (v) { return String(v).padStart(2, '0'); };
    var t = function () { return '2026/11/' + pad(1 + Math.floor(n / 6)) + ' ' + pad(9 + n % 9) + ':' + pad((n * 7) % 60); };
    var isEx = function (id) { return ex.some(function (e) { return e[0] === id; }); };
    for (var i = 1; i <= 150; i += 3) {
      var id = 'C' + String(i).padStart(3, '0');
      if (isEx(id)) continue;
      if (i % 5 === 0) rows.push({ ts: t(n++), id: id, reply: '尚未決定', reasons: '', note: '' });
      else if (i < 120) rows.push({ ts: t(n++), id: id, reply: '到場', reasons: '', note: '' });
    }
    ex.forEach(function (e) { rows.push({ ts: t(n++), id: e[0], reply: '申請免除', reasons: e[1], note: e[2] }); });
    return rows.sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
  })();

  /*
   * 示範附件：只在「載入示範資料」時使用，全部是虛構文件，畫面上有浮水印。
   * 用來展示承辦人員「打開附件 → 對照說明 → 標記結果」的流程；正式版改成顯示官方系統的附件。
   * C056 故意做成和說明不符（自稱民國 45 年次，文件是 46 年，未滿 70 歲），C161 是附錯文件。
   */
  var DEMO_DOCS = {
    C007: ['學生證（影本）', [['學校', '○○大學'], ['系級', '法律學系 三年級'], ['姓名', '林○○'], ['有效期限', '2027 年 7 月 31 日']]],
    C037: ['服務證明書', [['服務單位', '○○縣政府警察局○○分局'], ['職稱', '警員'], ['姓名', '陳○○'], ['任職期間', '2019 年 9 月起迄今']]],
    C055: ['身分證明文件（影本）', [['姓名', '王○○'], ['出生日期', '民國 43 年 5 月 2 日'], ['性別', '男']]],
    C056: ['身分證明文件（影本）', [['姓名', '張○○'], ['出生日期', '民國 46 年 3 月 18 日'], ['性別', '女']]],
    C075: ['在職證明書', [['公司', '○○保全股份有限公司'], ['職稱', '保全員'], ['姓名', '李○○'], ['到職日', '2021 年 4 月 1 日']]],
    C085: ['身分證明文件（影本）', [['姓名', '黃○○'], ['出生日期', '民國 45 年 8 月 9 日'], ['性別', '男']]],
    C090: ['戶口名簿（影本）', [['戶長', '吳○○（本人）'], ['配偶', '吳○○（現住○○市）'], ['長女', '吳○○，民國 113 年生']]],
    C107: ['身分證明文件（影本）', [['姓名', '許○○'], ['出生日期', '民國 40 年 1 月 25 日'], ['性別', '女']]],
    C150: ['服務證明書', [['服務單位', '臺灣○○地方檢察署'], ['職稱', '書記官'], ['姓名', '鄭○○'], ['任職期間', '2016 年 2 月起迄今']]],
    C161: ['戶口名簿（影本）', [['戶長', '周○○（本人）'], ['母', '周○○'], ['弟', '周○○']]]
  };
  /** 看附件時要核對什麼（依附件種類）。 */
  var DOC_HINT = [[/身分/, '出生年月日：算到今年是否已滿 70 歲'], [/學生證|在學/, '學校、身分與有效期限'],
    [/服務|在職/, '服務單位與職稱，是否屬第 14 條列舉的職業'], [/診斷/, '病名、日期與醫師建議'], [/戶口/, '家庭成員和申請事由有沒有關係'], [/受災|災害/, '受災地址與日期']];

  /* ---------- 設定與快取 ---------- */

  var $ = function (id) { return document.getElementById(id); };
  /** localStorage 包一層：私密視窗或封鎖儲存時不會壞掉。 */
  function storage(area) {
    return {
      get: function (k, d) { try { var v = window[area].getItem('court:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
      set: function (k, v) { try { window[area].setItem('court:' + k, JSON.stringify(v)); } catch (e) {} },
      del: function (k) { try { window[area].removeItem('court:' + k); } catch (e) {} }
    };
  }
  var local = storage('localStorage'), session = storage('sessionStorage');

  var DEFAULT_CFG = { source: 'webapp', webappUrl: '', sheetUrl: '', sheetName: '表單回應 1', model: 'gemini-2.5-flash', remember: false };
  var saved = local.get('cfg', {});
  // 舊版只有「公開試算表」一種來源；已經設定過試算表的，維持原本的來源
  var cfg = Object.assign({}, DEFAULT_CFG, saved.sheetUrl && !saved.source ? { source: 'csv' } : {}, saved);
  // 金鑰預設只存在這個分頁（關掉就忘記）；勾「記住」才存到 localStorage
  var apiKey = session.get('apiKey', '') || local.get('apiKey', '') || saved.apiKey || '';
  if (saved.apiKey) { // 舊版把金鑰和設定存在一起：搬到這個分頁的 sessionStorage，從 localStorage 刪掉
    delete cfg.apiKey; session.set('apiKey', apiKey); local.set('cfg', cfg);
  }
  // 存取碼只存在這個分頁。舊版存在 localStorage 的設定裡：搬過來，並從 localStorage 刪掉
  var token = session.get('token', '') || saved.token || '';
  if (saved.token) { delete cfg.token; session.set('token', token); local.set('cfg', cfg); }

  // 快取綁規則版本：lib/screening.js 改了規則，舊的分類結果就不用
  var CACHE_KEY = 'cache:' + S.RULES_VERSION;
  var cache = local.get(CACHE_KEY, {});
  // mode：remote（設定裡的資料來源）｜demo（示範資料）｜file（匯入的表格檔，只在本機處理）
  var rows = [], seen = null, timer = null, running = false, mode = 'remote';
  // Apps Script 回報的規則版本。和這一頁的不同，代表有人改了 lib/screening.js 卻還沒重新部署 Apps Script（或反過來）
  var remoteVersion = null;
  // 承辦人員打開附件後標記：true＝相符；{bad:true, why}＝不符，改人工審閱。沒標記的「核對附件後送法院」不算完成
  var docOk = local.get('docOk', {});

  function fillForm() {
    $('source').value = cfg.source;
    ['webappUrl', 'sheetUrl', 'sheetName', 'model'].forEach(function (k) { $(k).value = cfg[k] || ''; });
    $('token').value = token;
    $('apiKey').value = apiKey;
    $('remember').checked = !!cfg.remember;
    showSourceFields();
  }
  function showSourceFields() {
    var src = $('source').value;
    document.querySelectorAll('[data-source]').forEach(function (el) { el.hidden = el.getAttribute('data-source') !== src; });
  }

  /* ---------- 小工具 ---------- */

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var keyOf = function (r) { return r.ts + '|' + r.id; };
  var isEx = function (r) { return S.normalizeReply(r.reply) === '申請免除'; };
  var sleep = function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };

  /** Apps Script 寫在試算表的 AI 欄位 → 畫面用的結果物件。還沒分類完回傳 null。 */
  function fromSheet(ai) {
    if (!ai || !ai['AI 處理時間']) return null;
    return {
      '對應事由': ai['AI 對應事由'] || '無', '類型': ai['AI 類型'] || '無', 'AI建議': ai['AI 建議'] || '',
      '需人工確認': ai['需人工確認'] || '是', '理由': ai['AI 理由'] || '', '承辦待辦': ai['承辦待辦'] || ai['書記官待辦'] || '',
      src: ai['判斷來源'] === '規則' ? 'rule' : 'ai'
    };
  }
  /** 畫面用的最終結果（共用 finalize：欄位一致＋附件核對）。 */
  function view(r) {
    var c = S.finalize(cache[keyOf(r)], r), st = docOk[keyOf(r)];
    if (c && st && st.bad) c = Object.assign({}, c, { '需人工確認': '是', '承辦待辦': '附件與說明不符' + (st.why ? '：' + st.why : '') + '，請人工審閱', docHuman: true });
    return c;
  }
  /** 不需要追問、只差承辦人員核對附件的申請。 */
  var needsDocCheck = function (c) { return c && c.src !== 'pending' && c['需人工確認'] === '否'; };

  /**
   * 同一位候選人送出多次，以最後一次為準（和 Apps Script 的 rebuildDashboard、Looker Studio 一致）。
   * 例如先申請免除、後來改成會到場，撤回的那筆就不該留在待審清單。沒有編號的列各自保留。
   * @returns {{rows: Array, dropped: number}}
   */
  function latestPerId(list) {
    var at = {}, out = [];
    list.forEach(function (r, i) { var id = String(r.id || '').trim(); at[id || '#' + i] = i; });
    list.forEach(function (r, i) { var id = String(r.id || '').trim(); if (at[id || '#' + i] === i) out.push(r); });
    return { rows: out, dropped: list.length - out.length };
  }

  /* ---------- 讀取資料 ---------- */

  async function fetchRows() {
    if (cfg.source === 'webapp') {
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(cfg.webappUrl)) throw new Error('請在「設定」貼上 Apps Script 網頁應用程式網址（…/exec 結尾）');
      if (!token) throw new Error('請在「設定」輸入存取碼（只存在這個分頁，關掉就要重新輸入）');
      var res = await fetch(cfg.webappUrl + '?token=' + encodeURIComponent(token), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var j = await res.json();
      if (!j.ok) throw new Error(j.error || '讀取失敗');
      remoteVersion = j.rulesVersion || '（未知）';
      return j.rows;
    }
    var url = S.csvUrl(cfg.sheetUrl, cfg.sheetName);
    if (!url) throw new Error(/docs\.google\.com\/forms\//.test(cfg.sheetUrl || '')
      ? '這是表單的網址。請貼「回覆試算表」的網址（docs.google.com/spreadsheets/…）：在表單的「回覆」分頁按「在試算表中查看」，再複製網址列'
      : '請在「設定」貼上試算表網址，或按「載入示範資料」');
    var r2 = await fetch(url, { cache: 'no-store' });
    if (!r2.ok) throw new Error('HTTP ' + r2.status);
    var txt = await r2.text();
    if (/^\s*</.test(txt)) throw new Error('讀不到資料，請確認試算表已共用為「知道連結的任何人都能檢視」');
    // 用標題找欄位（和匯入表格檔相同）；認不出時照表單順序：A 時間戳記、B 編號、C 回覆、D 事由、E 說明、F 附件
    return S.rowsFromTable(S.parseCSV(txt)).rows;
  }

  async function load(fromDemo) {
    try {
      var all, msg;
      remoteVersion = null;
      if (fromDemo) { all = DEMO.map(function (r) { return Object.assign({}, r); }); msg = '示範資料（虛構）'; }
      else { $('status').textContent = '讀取中……'; all = await fetchRows(); msg = '已更新 ' + new Date().toLocaleTimeString('zh-TW', { hour12: false }); }
      show(all, msg, fromDemo ? 'demo' : 'remote');
    } catch (err) {
      $('status').textContent = '讀取失敗：' + err.message;
      if (!fromDemo) { $('settings').open = true; $('cfgMsg').textContent = '讀取失敗：' + err.message; }
    }
  }

  /** 讀到的資料列 → 去重、顯示、分類。三種來源（設定、示範、匯入）共用。 */
  function show(all, msg, m) {
    mode = m;
    $('cfgMsg').textContent = '';
    if (m !== 'remote') remoteVersion = null;
    var latest = latestPerId(all);
    rows = latest.rows;
    $('status').textContent = msg + (latest.dropped ? '（有 ' + latest.dropped + ' 筆是同一人重複送出，以最後一次為準）' : '');
    $('verWarn').hidden = !remoteVersion || remoteVersion === S.RULES_VERSION;
    $('verWarn').textContent = '⚠ 規則版本不一致：Apps Script 是 ' + remoteVersion + '，這一頁是 ' + S.RULES_VERSION +
      '。兩邊的判斷可能不同。請把 apps-script/Code.gs 重新貼進 Apps Script，部署新版本，再按選單「分類所有尚未處理的申請」重判舊版規則判的申請。';
    // 網頁應用程式模式：Apps Script 已經分類好的，直接用
    rows.forEach(function (r) { var c = fromSheet(r.ai); if (c) cache[keyOf(r)] = c; });
    render(); classifyAll();
  }

  /**
   * 匯入的表格檔 → 二維陣列。先當 UTF-8 讀；不是合法的 UTF-8 就當 Big5（Excel「另存 CSV」在繁中 Windows 常是 Big5）。
   * Tab 分隔的檔案也讀得懂。
   */
  async function readTable(file) {
    var buf = await file.arrayBuffer(), text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('big5').decode(buf); }
    text = text.replace(/^\uFEFF/, '');
    var first = text.split(/\r?\n/, 1)[0];
    return S.parseCSV(text, /\t/.test(first) && !/,/.test(first) ? '\t' : ',');
  }

  /** AI 的結果才值得存（規則每次重算都一樣，也不必把規則判的理由留在瀏覽器裡）。 */
  function aiOnly(c) {
    var out = {};
    Object.keys(c).forEach(function (k) { if (c[k] && c[k].src === 'ai') out[k] = c[k]; });
    return out;
  }

  /* ---------- 畫面 ---------- */

  function render() {
    var ex = rows.filter(isEx);
    var go = rows.filter(function (r) { return S.normalizeReply(r.reply) === '會到場'; });
    var und = rows.filter(function (r) { return S.normalizeReply(r.reply) === '尚未決定'; });
    var done = ex.filter(function (r) { var c = view(r); return c && c.src !== 'pending'; });
    var chk = ex.filter(function (r) { var c = view(r); return c && c['需人工確認'] === '是'; });
    var byRule = done.filter(function (r) { return cache[keyOf(r)].src === 'rule'; }).length, byAI = done.length - byRule;
    var docTodo = ex.filter(function (r) { return needsDocCheck(view(r)) && docOk[keyOf(r)] !== true; });
    var notices = ex.filter(function (r) { return S.noticeFor(view(r), r); });
    $('kpis').innerHTML = [
      [rows.length, '已回覆人數'], [go.length, '回覆會到場'], [ex.length, '表明不能或拒絕擔任'], [und.length, '尚未決定'],
      [byRule + '<small> / ' + byAI + '</small>', '規則判 / AI 判'], [chk.length, '需承辦確認', 'warn'], [notices.length, '需補件'], [docTodo.length, '待核對附件', 'warn']
    ].map(function (k) { return '<div class="kpi ' + (k[2] || '') + '"><b>' + k[0] + '</b><span>' + k[1] + '</span></div>'; }).join('');
    if (!ex.length) { $('rows').innerHTML = '<tr><td colspan="8" class="empty">目前沒有表明不能或拒絕擔任的回覆</td></tr>'; return; }
    // 第一次載入不標示；之後新進來的申請閃一下
    var prev = seen; seen = new Set(ex.map(keyOf));
    var SRC = { rule: '規則判', ai: 'AI 判', pending: '待 AI' };
    $('rows').innerHTML = ex.slice().reverse().map(function (r) {
      var k = keyOf(r), c = view(r), fresh = prev && !prev.has(k);
      var adv = c ? c['AI建議'] : '', cls = adv === '可能符合' ? 'ok' : adv === '資料不足' ? 'warn' : adv ? 'bad' : '';
      var src = c && SRC[c.src] ? c.src : 'pending';
      return '<tr class="' + (fresh ? 'new' : '') + '"><td class="id">' + esc(r.id) + '</td><td>' + esc(r.reasons) + '</td><td>' + esc(r.note) + '</td>' +
        '<td>' + (c ? esc(c['對應事由']) : '<span class="status">分類中…</span>') + '</td><td>' + (c ? esc(c['類型']) : '') + '</td>' +
        '<td>' + (c ? '<span class="who ' + src + '">' + SRC[src] + '</span> <span class="badge ' + cls + '">' + esc(adv) + '</span><div class="src">' + esc(c['理由']) + (c['依據'] ? '<br>' + esc(c['依據']) : '') + '</div>' : '') + '</td>' +
        '<td>' + (c ? (c['需人工確認'] === '是' ? '<span class="check">是</span>' : '否') : '') + '</td>' +
        '<td' + (c && c.docBad ? ' class="check"' : '') + '>' + (c ? esc(c['承辦待辦']) : '') + docBox(k, c, r) +
        (S.noticeFor(c, r) ? '<button class="notice-btn" data-n="' + esc(k) + '">補件通知草稿</button>' : '') + '</td></tr>';
    }).join('');
  }

  /** 附件狀態與「查看附件」按鈕。標記結果要在附件視窗裡做：沒打開附件就不能標記。 */
  function docBox(k, c, r) {
    var claimed = S.claimedDoc(r.note), st = docOk[k], n = S.fileLinks(r.files).length;
    if (!claimed && !n && !needsDocCheck(c)) return '';
    var tag = st === true ? '<span class="doc done">✓ 附件已核對，可送法院</span>'
      : st && st.bad ? '<span class="doc bad">✗ 附件與說明不符</span>'
      : needsDocCheck(c) ? '<span class="doc">待核對附件</span>' : '';
    return tag + (n ? '<span class="src">已上傳 ' + n + ' 個檔案</span>' : '') + '<button class="doc-btn" data-d="' + esc(k) + '">查看附件</button>';
  }

  /** 示範附件：簡單的文件樣式＋浮水印，刻意不仿照任何官方證件的版面。 */
  function docSvg(d) {
    var rowsSvg = d[1].map(function (f, i) {
      var y = 118 + i * 44;
      return '<text x="40" y="' + y + '" font-size="17" fill="#6b6676">' + esc(f[0]) + '</text><text x="170" y="' + y + '" font-size="19" fill="#22202a">' + esc(f[1]) + '</text>' +
        '<line x1="40" x2="520" y1="' + (y + 14) + '" y2="' + (y + 14) + '" stroke="#e4dfd3"/>';
    }).join('');
    return '<svg viewBox="0 0 560 340" role="img" aria-label="' + esc(d[0]) + '（示範用虛構文件）" style="width:100%;height:auto;display:block;font-family:var(--f)">' +
      '<rect x="1" y="1" width="558" height="338" rx="10" fill="#fdfcf8" stroke="#cfc8b8"/>' +
      '<text x="40" y="62" font-size="24" font-weight="700" fill="#22202a">' + esc(d[0]) + '</text>' + rowsSvg +
      '<text x="280" y="210" font-size="44" font-weight="700" fill="#b33a32" fill-opacity=".16" text-anchor="middle" transform="rotate(-18 280 190)">示範用虛構文件</text>' +
      '<text x="40" y="318" font-size="13" fill="#9a94a6">競賽示範・非真實文件・姓名與資料皆為虛構</text></svg>';
  }

  var docKey = null;
  function openDoc(k) {
    var r = rows.filter(function (x) { return keyOf(x) === k; })[0];
    if (!r) return;
    docKey = k;
    var claimed = S.claimedDoc(r.note), d = mode === 'demo' ? DEMO_DOCS[r.id] : null, c = view(r), links = S.fileLinks(r.files);
    var hint = claimed && DOC_HINT.filter(function (h) { return h[0].test(claimed); })[0];
    $('docTitle').textContent = '附件核對：' + r.id;
    $('docView').innerHTML = links.length ? '<div class="files">' + links.map(function (u, i) {
        return '<a class="btn" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">開啟附件 ' + (i + 1) + '（Google 雲端硬碟，另開分頁）</a>';
      }).join('') + '<p class="fine">民眾在表單上傳的檔案，存在表單擁有者的雲端硬碟；要用有權限的 Google 帳號登入才看得到。</p></div>' + (d ? docSvg(d) : '')
      : d ? docSvg(d)
      : '<p class="empty">' + (mode === 'demo' ? '這筆沒有附件檔。' : '這個資料來源沒有附件檔。正式導入時，這裡顯示官方系統收到的附件（見介接規格）；目前請對照紙本或郵寄的文件。') + '</p>';
    $('docInfo').innerHTML = '<dl><dt>民眾寫的附件</dt><dd>' + esc(claimed || '（說明中沒有寫）') + '</dd>' +
      '<dt>勾選事由</dt><dd>' + esc(r.reasons) + '</dd><dt>民眾說明</dt><dd>' + esc(r.note) + '</dd>' +
      '<dt>初篩結果</dt><dd>' + (c ? esc(c['對應事由'] + '｜' + c['AI建議']) : '分類中') + '</dd>' +
      (hint ? '<dt>請核對</dt><dd><b>' + esc(hint[1]) + '</b></dd>' : '') + '</dl>';
    var st = docOk[k];
    $('docWhy').value = st && st.why || '';
    $('docState').textContent = st === true ? '目前標記：相符' : st && st.bad ? '目前標記：不符' : '尚未標記';
    $('docDlg').showModal();
  }
  function markDoc(v) {
    if (!docKey) return;
    if (v === null) delete docOk[docKey]; else docOk[docKey] = v;
    local.set('docOk', docOk); $('docDlg').close(); render();
  }

  /* ---------- Gemini（只有公開試算表／示範模式、而且有填金鑰時才用） ---------- */

  async function gemini(prompt, json) {
    var body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: Object.assign({ temperature: 0.1 }, json === false ? {} : { responseMimeType: 'application/json' }) };
    for (var a = 0; a < 3; a++) {
      var res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cfg.model || 'gemini-2.5-flash') + ':generateContent',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) });
      if (res.status === 429 || res.status >= 500) { await sleep(6000 * (a + 1)); continue; }
      var j = await res.json();
      if (!res.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + res.status));
      var parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      return parts.map(function (p) { return p.text || ''; }).join('');
    }
    throw new Error('超過免費額度，稍後再試');
  }

  /** 逐筆分類：已有結果的跳過；先規則，判不了且有金鑰才問 AI。 */
  async function classifyAll() {
    if (running) return; running = true;
    try {
      var fromWebapp = cfg.source === 'webapp' && mode === 'remote';
      // 網頁應用程式模式由 Apps Script 負責 AI；匯入的表格只在本機處理，不送 AI
      var useAI = !!apiKey && !fromWebapp && mode !== 'file';
      var list = rows.filter(isEx);
      for (var i = 0; i < list.length; i++) {
        var r = list[i], k = keyOf(r);
        if (cache[k] && !(useAI && cache[k].src === 'pending')) continue; // 補上金鑰後，等 AI 的申請再送一次
        var out = S.ruleClassify(r);
        if (out) { cache[k] = out; render(); continue; }
        if (useAI) {
          try { out = S.checkAI(S.parseJson(await gemini(S.buildPrompt(r))), r); }
          catch (err) { $('status').textContent = 'AI 失敗：' + err.message; out = S.pendingResult('請人工審閱（AI 暫時無法使用）'); }
        } else out = S.pendingResult(fromWebapp ? 'Apps Script 尚未分類，請稍後重新整理' : mode === 'file' ? '請人工審閱（匯入的資料只在本機用規則判，不送 AI）' : undefined);
        cache[k] = out; if (out.src === 'ai') local.set(CACHE_KEY, aiOnly(cache)); render();
        if (useAI) await sleep(1200);
      }
    } finally { running = false; }
  }

  /* ---------- 承辦摘要 ---------- */

  /** 由程式統計（lib/screening.js 的 summarize），不用 AI，也不會把申請內容送出去。 */
  function summary() {
    var ex = rows.filter(isEx);
    if (!ex.length) { $('summary').textContent = '目前沒有表明不能或拒絕擔任的回覆。'; return; }
    $('summary').textContent = S.summarize(ex.map(function (r) {
      var k = keyOf(r);
      return { id: r.id, c: view(r) || S.pendingResult('分類中，請稍後'), checked: docOk[k] === true };
    }));
  }

  /* ---------- 事件 ---------- */

  $('source').onchange = showSourceFields;
  $('save').onclick = function () {
    cfg = {
      source: $('source').value, webappUrl: $('webappUrl').value.trim(),
      sheetUrl: $('sheetUrl').value.trim(), sheetName: $('sheetName').value.trim() || '表單回應 1',
      model: $('model').value.trim() || 'gemini-2.5-flash', remember: $('remember').checked
    };
    apiKey = $('apiKey').value.trim();
    token = $('token').value.trim();
    local.set('cfg', cfg); // 存取碼不放進 cfg：只存在這個分頁
    session.set('token', token);
    session.set('apiKey', apiKey);
    if (cfg.remember) local.set('apiKey', apiKey); else local.del('apiKey');
    $('settings').open = false; load();
  };
  $('forget').onclick = function () {
    local.del('apiKey'); session.del('apiKey'); session.del('token'); local.del('cfg'); apiKey = ''; token = ''; cfg = Object.assign({}, DEFAULT_CFG); fillForm();
    $('status').textContent = '已清除這台電腦上的設定、存取碼與金鑰';
  };
  $('clearCache').onclick = function () { cache = {}; local.set(CACHE_KEY, cache); render(); classifyAll(); };
  $('importFile').onchange = async function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      var t = S.rowsFromTable(await readTable(f));
      if (!t.rows.length) throw new Error('檔案裡沒有資料列');
      clearInterval(timer); $('auto').checked = false; // 自動更新會改讀設定裡的資料來源，蓋掉匯入的資料
      show(t.rows, '已匯入「' + f.name + '」' + t.rows.length + ' 列，只在這台電腦處理，不會上傳' + (t.fallback ? '（標題認不出來，照 A–E 欄的順序讀）' : ''), 'file');
    } catch (err) { $('status').textContent = '匯入失敗：' + err.message; }
    e.target.value = '';
  };
  $('refresh').onclick = function () { load(); };
  $('demo').onclick = function () { load(true); };
  $('sumBtn').onclick = summary;
  /**
   * 補件通知草稿：依事由用固定範本產生（lib/screening.js 的 noticeFor），不送 AI。
   * 只發給「沒附證明、附錯證明、說明不夠具體」的申請；承辦人員改好再寄。
   */
  function showNotices(list) {
    var texts = list.map(function (r) { var n = S.noticeFor(view(r), r); return n && n.text; }).filter(Boolean);
    if (!texts.length) { $('status').textContent = '目前沒有需要補件的申請'; return; }
    $('noticeText').value = texts.join('\n\n────────────────────\n\n');
    $('noticeStatus').textContent = texts.length + ' 份草稿';
    $('noticePanel').hidden = false;
    $('noticePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('rows').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.notice-btn');
    if (!b) return;
    var k = b.getAttribute('data-n');
    showNotices(rows.filter(function (r) { return keyOf(r) === k; }));
  });
  $('noticeAll').onclick = function () { showNotices(rows.filter(isEx)); };
  $('noticeCopy').onclick = function () {
    var t = $('noticeText');
    try {
      navigator.clipboard.writeText(t.value).then(function () { $('noticeStatus').textContent = '已複製'; }, function () { t.select(); $('noticeStatus').textContent = '請按 Ctrl+C 複製'; });
    } catch (err) { t.select(); $('noticeStatus').textContent = '請按 Ctrl+C 複製'; }
  };
  $('rows').addEventListener('click', function (e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-d');
    if (k) openDoc(k);
  });
  $('docOkBtn').onclick = function () { markDoc(true); };
  $('docBadBtn').onclick = function () { markDoc({ bad: true, why: $('docWhy').value.trim().slice(0, 40) }); };
  $('docClear').onclick = function () { markDoc(null); };
  $('docClose').onclick = function () { $('docDlg').close(); };
  $('auto').onchange = function (e) { clearInterval(timer); if (e.target.checked) timer = setInterval(function () { load(); }, 20000); };

  // 清掉舊版本的快取，避免 localStorage 越積越多
  try { Object.keys(localStorage).forEach(function (k) { if (/^court:cache/.test(k) && k !== 'court:' + CACHE_KEY) localStorage.removeItem(k); }); } catch (e) {}

  fillForm();
  if (cfg.source === 'webapp' && cfg.webappUrl && !token) { $('settings').open = true; $('status').textContent = '請輸入存取碼（只存在這個分頁，關掉就要重新輸入）'; }
  else if (cfg.webappUrl || cfg.sheetUrl) load(); else $('settings').open = true;
})();
