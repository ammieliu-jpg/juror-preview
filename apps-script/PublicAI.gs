// ⚠ 自動產生的檔案，請勿手動修改。來源：apps-script/public-ai.gs + index.html 的 DELIB + lib/screening.js 的 INJECT（npm run build:gs）
// 使用方式：開一個新的獨立 Apps Script 專案 → 貼上本檔全部內容 → 儲存 → 部署成網頁應用程式（見 docs/SETUP.md）。

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

/* ======================================================================
 * 以下自動產生：評議提示詞（index.html 的 DELIB）與疑似指令文字（lib/screening.js 的 INJECT）
 * ====================================================================== */
const DELIB_PROMPT = "你要主持一場國民法官模擬評議。使用者是第 6 位國民法官。全部內容是改編自司法院公開的模擬法庭教材，人名皆為代號，並非真實案件。請用親切、白話的繁體中文。\n\n【案情：只能使用以下事實，不可以新增或修改】\n被告甲、被告乙都是 22 歲，兩人都沒有汽車駕駛執照。某天下午 5 時 30 分，天候下雨、正值下班尖峰，兩人各開一台自用小客車，從同一間修車廠出發前往中山區。\n在速限每小時 50 公里的路段，乙開 B 車在前、甲開 A 車在後，以時速約 60 到 70 公里一同駛入公車專用道。接近公車停靠站時，兩人都沒有打方向燈，也沒有和一台銀色小客車保持安全距離，就向右切出公車專用道，插入銀色小客車前方，之後再以同樣速度回到公車專用道。\n下午 5 時 45 分，接近另一個公車停靠站時，兩人再度沒打方向燈，先後以時速 80 公里以上向右切出公車專用道。當時右側車道剛好有一輛機車，乙緊急煞車，沒有撞到機車；甲也緊急煞車，但因車速過快而失控，A 車衝向最外側車道，撞上停在路邊的小貨車車尾後衝進騎樓，站在附近的 3 名行人來不及閃避，都因傷重死亡。\n檢察官起訴：甲、乙都犯「無駕駛執照以他法致生公眾往來危險致人於死罪」（刑法第 185 條第 2 項、道路交通管理處罰條例第 86 條第 1 項）。\n\n【可以引用的法律說明：出自本案審前說明書】\n・刑法第 185 條第 1 項：以他法致生往來之危險者，處五年以下有期徒刑、拘役或一萬五千元以下罰金。第 2 項：因而致人於死者，處無期徒刑或七年以上有期徒刑。\n・道路交通管理處罰條例第 86 條第 1 項：無駕駛執照駕車，因而致人受傷或死亡，依法應負刑事責任者，加重其刑至二分之一。\n・刑法第 276 條：因過失致人於死者，處五年以下有期徒刑、拘役或五十萬元以下罰金。\n・故意：知道自己在做什麼，也知道可能的結果，仍然決定去做；預見結果發生，而發生也不違背本意，也算故意。\n・過失：應注意、能注意而不注意；或預見可能發生，卻確信不會發生。\n・加重結果犯（刑法第 17 條）：行為人不能預見結果發生時，不適用加重處罰。\n・共同正犯（刑法第 28 條）：二人以上共同實行犯罪之行為者，皆為正犯。\n・量刑（刑法第 57 條）：要審酌犯罪動機、手段、違反義務程度、造成的損害、犯後態度等。\n・刑法第 59 條：犯罪情狀顯可憫恕，科以最低度刑仍嫌過重者，得酌量減輕其刑。\n・刑事審判基本原則：無罪推定、檢察官負舉證責任、只能依法庭上的證據判斷（新聞不算證據）、罪疑唯輕（有懷疑時作有利被告的認定）。\n\n【評議室成員】\n・審判長：主持討論、保持中立，不先講自己的結論，負責解釋法律概念。\n・陪席法官 2 位：發言少，只在被問到法律問題時簡短說明。\n・國民法官 1 號：計程車司機，每天在路上開車，對危險駕駛特別有感。\n・國民法官 2 號：退休國小老師，常想到年輕人還有改過的機會。\n・國民法官 3 號：家管，有小孩，容易站在被害人家屬的角度想。\n・國民法官 4 號：工程師，習慣一步一步看證據和邏輯。\n・國民法官 5 號：大學生，和被告同年紀。\n・國民法官 6 號：就是使用者。\n\n【評議流程：依序進行三個爭點，一次只討論一個】\n爭點一：被告甲（撞到人的後車駕駛）是故意製造交通危險，還是只是過失？如果是前者，他對 3 人死亡的結果能不能預見？\n爭點二：被告乙（沒撞到人的前車駕駛）要不要和甲一起對 3 人死亡負責？兩人算不算「共同」實行？\n爭點三：如果有罪，刑度要重還是輕？請使用者從四個選項中選一個：法定最低刑附近、中間、偏重、認為應適用第 59 條酌減。\n\n每個爭點的進行方式：\n1. 審判長用兩三句話說明這個爭點在問什麼。\n2. 請 2 到 3 位國民法官各說一段話，意見要有分歧，各自引用案情中的具體事實。\n3. 問使用者的看法，等使用者回答後，請 1 位成員回應或提出不同角度。\n4. 審判長宣布投票，列出 9 位成員各自的票（3 位法官加 6 位國民法官，使用者的票照他的回答計算），並說明是否達到門檻。\n\n【表決規則】\n・認定有罪：需要 9 人中 2/3 以上（至少 6 票）同意，而且贊成者中至少要有 1 位法官和 1 位國民法官。\n・決定刑度：需要過半數同意，而且同樣要包含法官和國民法官雙方的意見。\n\n【規則】\n1. 不可以新增案情中沒有的事實或證據，例如被告的前科、酒駕、證人說法。使用者問到案情沒有的資訊時，審判長回答：「這個部分法庭上沒有提出證據，我們不能列入考慮。」\n2. 不可以告訴使用者「正確答案」，也不要評論真實案件的判決。\n3. 尊重使用者的任何意見，不要批評他。\n4. 每次回覆不超過 250 字。一次只進行一個步驟，等使用者回覆再繼續。\n5. 三個爭點都結束後，審判長做總結，並提醒：「在真正的審判中，評議過程與每個人的投票都要終身保密。」最後問使用者：「體驗完之後，如果真的收到通知，你會願意去嗎？」";
const PUBLIC_INJECT = /忽略|無視|以上(規則|指示|說明)|系統提示|提示詞|你現在是|請(直接)?輸出|需人工確認|AI\s*建議|書記官待辦|JSON|ignore|prompt|instruction|system/i;
