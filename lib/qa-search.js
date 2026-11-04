/**
 * lib/qa-search.js：右下角手機「國民法官小幫手」的問答比對（純函式）
 * =================================================================
 *
 * index.html 用 <script src="lib/qa-search.js"> 載入成全域變數 QASearch；單元測試用 require。
 *
 * 三種回答方式，由快到慢：
 *   1. chatReply()：打招呼、問身分這類閒聊，直接回固定句子，不拿去比對
 *   2. keywordAnswer()：雙字詞（bigram）重疊比對，不需下載任何東西（模型載入前或失敗時用）
 *   3. hybridAnswer()：瀏覽器內語意模型（bge-small-zh-v1.5）算出的相似度為主，再加一點關鍵字分數
 *      （向量計算在 index.html，這裡只負責「分數 → 選哪一題 → 怎麼回答」）
 *
 * 不管哪一種，都只回答資料庫（司法院常見問答）裡有的內容並附出處；分數不夠就請民眾直接問法院。
 */
var QASearch = (function () {
  'use strict';

  var NOT_FOUND = '這個問題目前資料庫沒有收錄，建議直接聯繫通知書上的承辦法院確認。';
  /** 太常見、沒有鑑別力的雙字詞，不列入比對。 */
  var STOP = new Set(['可以', '以在', '會不', '不會', '國民', '民法', '法官', '什麼', '怎麼', '我的', '法院', '以帶', '可能', '一定']);
  /** 門檻：低於 KEYWORD_MIN／SEM_MIN 就回「沒有收錄」；介於 SEM_MIN 和 SEM_SURE 之間會加上「我不太確定」。 */
  var KEYWORD_MIN = 0.6, SEM_MIN = 0.6, SEM_SURE = 0.72, KEYWORD_WEIGHT = 0.08;
  var MAX_ANSWER = 420;

  /** 把問題切成雙字詞集合（去掉標點與停用詞）。 */
  function bigrams(s) {
    s = String(s || '').replace(/[\s，。？！、（）「」：；,.?!]/g, '');
    var o = new Set();
    for (var i = 0; i < s.length - 1; i++) { var x = s.slice(i, i + 2); if (!STOP.has(x)) o.add(x); }
    return o;
  }

  /**
   * 從提示詞裡的資料庫文字解析出題目。格式（每題四行）：
   *   Q3637（費用）問：……
   *   答：……
   *   出處：……
   * @param {string} kb   完整提示詞（index.html 的 KB）
   * @param {Object<string,string>} [alt]  口語問法，用「｜」分隔
   */
  function parseEntries(kb, alt) {
    alt = alt || {};
    var re = /^((?:Q36\d\d|A\d{3}))（(.+?)）問：(.+)\n答：([\s\S]*?)\n出處：(.+)$/gm, m, out = [];
    while ((m = re.exec(kb))) {
      var e = { id: m[1], cat: m[2], q: m[3], a: m[4].trim(), src: m[5].trim() };
      e.alt = alt[e.id] || '';
      e.bq = bigrams(e.q + e.alt);
      e.ba = bigrams(e.a);
      out.push(e);
    }
    return out;
  }

  /** 關鍵字分數：問題裡的雙字詞出現在題目（含口語問法）得 2 分，只出現在答案得 0.6 分，再除以長度。 */
  function keywordScore(e, b) {
    var s = 0;
    b.forEach(function (x) { if (e.bq.has(x)) s += 2; else if (e.ba.has(x)) s += 0.6; });
    return s / Math.max(4, b.size);
  }

  function formatAnswer(e) {
    var a = e.a.length > MAX_ANSWER ? e.a.slice(0, MAX_ANSWER) + '……' : e.a;
    return '最接近的問題是：「' + e.q + '」\n\n' + a + '\n\n出處：' + e.src;
  }

  /** 找分數最高的一題；回傳 {entry, score}（找不到 entry 為 null）。 */
  function bestKeyword(entries, q) {
    var b = bigrams(q), best = null, score = 0;
    entries.forEach(function (e) { var s = keywordScore(e, b); if (s > score) { score = s; best = e; } });
    return { entry: best, score: score };
  }

  /** 只用關鍵字回答。 */
  function keywordAnswer(entries, q) {
    var r = bestKeyword(entries, q);
    return !r.entry || r.score < KEYWORD_MIN ? NOT_FOUND : formatAnswer(r.entry);
  }

  /**
   * 混合排序：語意相似度為主，加上關鍵字分數（上限 2）× 0.08，避免只靠語意配錯題。
   * @param {Map<object,number>} semScores  每一題的最高語意相似度（cosine，已正規化）
   * @returns {Array<[object,number]>} 由高到低
   */
  function hybridRank(entries, semScores, q) {
    var b = bigrams(q);
    return entries.filter(function (e) { return semScores.has(e); })
      .map(function (e) { return [e, semScores.get(e) + KEYWORD_WEIGHT * Math.min(keywordScore(e, b), 2)]; })
      .sort(function (x, y) { return y[1] - x[1]; });
  }

  function hybridAnswer(entries, semScores, q) {
    var top = hybridRank(entries, semScores, q);
    if (!top.length || top[0][1] < SEM_MIN) return NOT_FOUND;
    var txt = formatAnswer(top[0][0]);
    if (top[0][1] < SEM_SURE && top[1]) txt = '我不太確定你問的是不是這題，請參考：\n\n' + txt + '\n\n其他可能相關：「' + top[1][0].q + '」';
    return txt;
  }

  /** 閒聊：打招呼、問身分、道謝。 */
  var CHAT = [
    [/^(你是誰|你是什麼|你是ai嗎|你是機器人嗎|介紹一下你自己|你可以做什麼|你會什麼)/i, '我是國民法官小幫手，一個在你瀏覽器裡執行的 AI 問答工具。我只根據司法院國民法官專區的常見問答回答，並附上出處；資料庫沒有的問題，我會請你直接問法院。你可以試試問：「去一天有多少錢？」'],
    [/^(你好|哈囉|嗨|hi|hello|安安)/i, '你好！有任何關於國民法官的問題都可以問我，例如：「可以請公假嗎？」「被告會不會來找我？」'],
    [/^(謝謝|感謝|thanks|thank you|3q)/i, '不客氣！還有其他問題隨時問我。']
  ];
  function chatReply(q) {
    var s = String(q || '').trim().replace(/[？?！!。.～~]+$/, '');
    for (var i = 0; i < CHAT.length; i++) if (CHAT[i][0].test(s)) return CHAT[i][1];
    return null;
  }

  /** 牽涉個人狀況（免除、我是…）或答不出來時，要在回答下面放 PartyRock 的 AI 導覽連結。 */
  function needsPersonalHelp(q, answer) {
    return /沒有收錄|免除|拒絕|不得擔任|我是|我有|我的狀況|我家/.test(String(q) + String(answer));
  }

  return {
    NOT_FOUND: NOT_FOUND, bigrams: bigrams, parseEntries: parseEntries, keywordScore: keywordScore,
    bestKeyword: bestKeyword, keywordAnswer: keywordAnswer, hybridRank: hybridRank, hybridAnswer: hybridAnswer,
    formatAnswer: formatAnswer, chatReply: chatReply, needsPersonalHelp: needsPersonalHelp
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QASearch;
