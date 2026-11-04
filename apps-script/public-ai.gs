/**
 * 民眾端 AI 代理｜模組 5「和 AI 法官自由討論」（取代 PartyRock，民眾不用登入）
 * =========================================================================
 *
 * ⚠ 這是原始碼。貼進 Apps Script 的是 apps-script/PublicAI.gs（npm run build:gs 產生，已含評議提示詞）。
 * ⚠ 請開一個「新的、獨立的」Apps Script 專案貼上，不要貼進法院端（模組 6）那個綁定試算表的專案：
 *   這個網址會公開給所有民眾，獨立專案碰不到任何試算表，就算被濫用也拿不到法院端資料。
 *
 * 流程：遊戲第 7 關 → 手機 → POST 到這個網頁應用程式 → 這裡加上伺服器端的評議提示詞 → Gemini → 回傳
 *   - 金鑰只存在「指令碼屬性」，不會出現在網頁或 GitHub 上
 *   - 提示詞在伺服器端，民眾只能送「自己說的話」，不能換掉提示詞，所以不會變成任人使用的免費 AI
 *   - 對話紀錄存在伺服器的快取（6 小時後自動清除），民眾不能偽造「AI 之前說過的話」
 *   - 限流：全站每分鐘、每天的次數上限，每場對話的回合上限，每句話的字數上限
 *   - 疑似指令文字（忽略規則、系統提示……）直接回固定句子，不送給 AI
 *   - 只討論虛構的模擬案件，不收集任何個資；請勿在這裡處理免除申請
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   GEMINI_API_KEY   必填。AI Studio 申請的金鑰（可以和模組 6 同一把，額度會共用）
 *   PUBLIC_AI        必填。設成 on 才會回應；改成 off 就立刻關閉（緊急開關，不用重新部署）
 *   GEMINI_MODEL     選填。預設 gemini-2.5-flash
 *   PER_MINUTE       選填。全站每分鐘上限，預設 8（免費版 Flash 每分鐘 10 次，留一點給模組 6）
 *   PER_DAY          選填。全站每天上限，預設 200
 *
 * 部署：部署 → 新增部署作業 → 類型「網頁應用程式」→ 執行身分「我」、存取權「所有人」→
 *   複製網址（…/exec），貼到 index.html 的 AI_PROXY。
 */

const PUBLIC_DEFAULT_MODEL = 'gemini-2.5-flash';
const PUBLIC_LIMITS = {
  perMinute: 8, perDay: 200,
  turns: 16,      // 一場評議最多 16 個回合（三個爭點綽綽有餘）
  input: 300,     // 民眾每句話最多 300 字
  output: 900,    // AI 回覆最多 900 字（提示詞要求 250 字內，多留空間）
  ttl: 21600,     // 對話紀錄保留 6 小時（CacheService 上限）
};
const GUARD_REPLY = '審判長：我們在評議室裡只討論本案的證據和爭點喔。請說說你對目前這個爭點的看法。';

/** 健康檢查：遊戲載入時先問一次，關閉中就不顯示「和 AI 法官自由討論」。 */
function doGet() {
  return publicJson_({ on: publicOn_(), kinds: ['delib'] });
}

/**
 * 請求：{"kind":"delib","sid":"瀏覽器產生的亂數","text":"民眾這一句話"}
 * 回應：{"reply":"…","left":剩餘回合} 或 {"error":"off|bad_request|too_long|session_full|busy|ai_failed"}
 * 遊戲用 Content-Type: text/plain 送出，瀏覽器不會先發 CORS 預檢，Apps Script 才收得到。
 */
function doPost(e) {
  let req;
  try { req = JSON.parse(e && e.postData ? e.postData.contents : ''); } catch (_) { return publicJson_({ error: 'bad_request' }); }
  if (!publicOn_()) return publicJson_({ error: 'off' });
  return publicJson_(handleDelib_(req || {}));
}

/** 主要邏輯（獨立出來方便測試）。 */
function handleDelib_(req) {
  if (req.kind !== 'delib') return { error: 'bad_request' };
  const sid = String(req.sid || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(sid)) return { error: 'bad_request' };
  const text = String(req.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'bad_request' };
  if (text.length > PUBLIC_LIMITS.input) return { error: 'too_long' };
  if (PUBLIC_INJECT.test(text)) return { reply: GUARD_REPLY, guarded: true };

  const cache = CacheService.getScriptCache();
  const key = 'h:' + sid;
  let hist = [];
  try { hist = JSON.parse(cache.get(key) || '[]'); } catch (_) { hist = []; }
  const used = hist.filter(m => m.role === 'user').length;
  if (used >= PUBLIC_LIMITS.turns) return { error: 'session_full' };
  if (!takeQuota_()) return { error: 'busy' };

  hist.push({ role: 'user', parts: [{ text }] });
  let reply;
  try { reply = callGemini_(hist); } catch (err) { console.error(err); return { error: 'ai_failed' }; }
  reply = String(reply).trim().slice(0, PUBLIC_LIMITS.output);
  hist.push({ role: 'model', parts: [{ text: reply }] });
  cache.put(key, JSON.stringify(hist), PUBLIC_LIMITS.ttl);
  return { reply, left: PUBLIC_LIMITS.turns - used - 1 };
}

function publicOn_() {
  const p = PropertiesService.getScriptProperties();
  return p.getProperty('PUBLIC_AI') === 'on' && !!p.getProperty('GEMINI_API_KEY');
}

/**
 * 全站限流：每分鐘、每天各一個計數器。超過就回 busy，遊戲會改回劇本評議。
 * 用鎖避免同時進來的請求讀到同一個數字。
 */
function takeQuota_() {
  const props = PropertiesService.getScriptProperties();
  const perMinute = +props.getProperty('PER_MINUTE') || PUBLIC_LIMITS.perMinute;
  const perDay = +props.getProperty('PER_DAY') || PUBLIC_LIMITS.perDay;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    const cache = CacheService.getScriptCache();
    const now = new Date();
    const mKey = 'm:' + Math.floor(now.getTime() / 60000);
    const dKey = 'd:' + Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd');
    const m = +cache.get(mKey) || 0;
    const d = +props.getProperty(dKey) || 0;
    if (m >= perMinute || d >= perDay) return false;
    cache.put(mKey, String(m + 1), 120);
    props.setProperty(dKey, String(d + 1));
    return true;
  } finally { lock.releaseLock(); }
}

/** 每天清掉前幾天的計數器（選用：觸發條件 → 時間驅動 → 每天）。 */
function cleanupCounters() {
  const props = PropertiesService.getScriptProperties();
  const today = 'd:' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  Object.keys(props.getProperties()).forEach(k => { if (/^d:/.test(k) && k !== today) props.deleteProperty(k); });
}

function callGemini_(contents) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_API_KEY');
  const model = encodeURIComponent(props.getProperty('GEMINI_MODEL') || PUBLIC_DEFAULT_MODEL);
  const body = {
    systemInstruction: { parts: [{ text: DELIB_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
  };
  const res = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const j = JSON.parse(res.getContentText() || '{}');
  if (code !== 200) throw new Error(`HTTP ${code} ${j.error ? j.error.message : ''}`);
  const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
  if (!parts) throw new Error('模型沒有回傳內容');
  return parts.map(p => p.text || '').join('');
}

function publicJson_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** 在編輯器裡按「執行」測試金鑰與提示詞。 */
function testPublicAI() {
  console.log(JSON.stringify(handleDelib_({ kind: 'delib', sid: 'editor-test-' + Date.now(), text: '開始' })));
}
