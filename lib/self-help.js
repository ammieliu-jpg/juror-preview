/**
 * lib/self-help.js：民眾端的「免除初篩」和「專屬準備清單」（取代 PartyRock 模組 2、3）
 * ===================================================================================
 *
 * 為什麼不用 PartyRock：民眾要先登入 AWS 帳號才能用，收到通知的人不會為了這個去註冊。
 * 為什麼不直接接 LLM：民眾描述的狀況常含病名、家人狀況等健康與家庭資料（個資法第 6 條），
 * 不該送到免費版 AI 服務。所以這兩個功能整個在瀏覽器裡跑，不登入、不送出任何資料。
 *
 *   checkSituation(text)：用白話描述狀況 → 對照國民法官法第 14、16 條，回傳初篩結果與說明草稿
 *     第一層沿用 Screening.ruleClassify（和法院端同一套規則：年齡、在學、法定職業、曾任）
 *     第二層是民眾端專用的關鍵字分類（疾病、照顧家人、災害、生活工作重大需要），
 *     這幾款要法院判斷「顯有困難」「重大」，所以只告訴民眾「可能符合，要寫清楚什麼」。
 *   buildGuide(role, worries, entries)：選身分和擔心的事 → 從常見問答挑出相關題目
 *     只引用資料庫原文，不產生新的文字，所以不會有 AI 幻覺。
 *
 * 純函式，不碰 DOM：index.html 用 <script src> 載入，測試用 require。
 * 結果一律是「可能符合」，是否准許由法院決定。
 */
var SelfHelp = (function () {
  'use strict';
  var S = typeof Screening !== 'undefined' ? Screening : require('./screening.js');

  /* ------------------------------------------------------------------
   * 免除初篩
   * ------------------------------------------------------------------ */

  /** 第 16 條各款：[白話標題, 條號, 建議附的證明] */
  var ART16 = {
    1: ['年滿 70 歲以上', '國民法官法第16條第1款', '身分證或戶口名簿影本'],
    2: ['公立或已立案私立學校的老師', '國民法官法第16條第2款', '教師證或在職證明'],
    3: ['公立或已立案私立學校的在校學生', '國民法官法第16條第3款', '學生證或在學證明'],
    4: ['有重大疾病、傷害或身心因素，執行職務顯有困難', '國民法官法第16條第4款', '診斷證明書'],
    6: ['要看護、養育親屬，執行職務顯有困難', '國民法官法第16條第6款', '被照顧者的診斷證明或戶口名簿影本'],
    7: ['遇到重大災害，要處理生活重建', '國民法官法第16條第7款', '受災證明'],
    8: ['生活、工作或家庭有重大需要，執行職務顯有困難', '國民法官法第16條第8款', '能說明那段期間無法到庭的文件（例如排班表、醫院預約單）'],
    9: ['5 年內當過國民法官或備位國民法官', '國民法官法第16條第9款', ''],
    10: ['1 年內曾被通知到庭當候選國民法官', '國民法官法第16條第10款', '']
  };

  // 具體的病況或治療：有寫才算「重大」的線索
  var ILL = /手術|開刀|住院|化療|放療|電療|癌|腫瘤|洗腎|透析|中風|骨折|復健|懷孕|孕|待產|坐月子|產後|身心障礙|身障|憂鬱|焦慮|恐慌|躁鬱|思覺失調|失智|重病|心臟|糖尿病|行動不便|輪椅|失明|視障|聽障|重聽|癲癇|創傷/;
  // 只說「身體不好」：不夠，請補充
  var VAGUE_ILL = /身體不好|身體不舒服|不舒服|身體差|不太好|很累|生病|有病/;
  var CARE = /照顧|看護|照護|養育|帶小孩|顧小孩|顧孩子|餵奶|哺乳|臥床|接送/;
  var DISASTER = /水災|淹水|火災|地震|颱風|土石流|受災|災民|房子.{0,4}(倒|毀|燒|淹)/;
  var NEED = /工作|上班|請假|老闆|公司|收入|生意|擺攤|攤販|自營|開店|考試|國考|出國|出差|婚禮|結婚|搬家|農忙|輪班|值班/;
  var RECENT = /(去年|今年|一年內|上次|之前).{0,10}(候選|選任|收到.{0,6}通知.{0,6}到庭)/;
  var ALONE = /只有我|沒有(其他)?人|沒人|沒有別人|一個人/;

  function item(k) { return { k: k, label: ART16[k][0], law: ART16[k][1], doc: ART16[k][2] }; }

  /**
   * @param {string} text  民眾自己描述的狀況
   * @param {{rocYear?:number}} [opts]
   * @returns {{verdict:'cannot'|'may'|'judge'|'none'|'more', title:string, items:Array, tips:string[], cites:string[], draft:string}}
   *   cannot：可能「不得擔任」　may：可能「得拒絕」，看條文就清楚
   *   judge：可能「得拒絕」，但要法院判斷「重大」「顯有困難」　none：看起來不符合　more：請補充
   */
  function checkSituation(text, opts) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 500);
    if (s.length < 4) return result('more', [], ['請多寫一點，例如你的身分（上班族、學生）、年齡，或是有什麼狀況讓你不方便到庭。'], ['A017'], s);

    // 第一層：和法院端同一套規則
    var r = S.ruleClassify({ reasons: '', note: s }, opts);
    if (r && r['類型'] === '不得擔任') {
      var job = { k: 14, label: r['對應事由'].replace(/^第14條職業因素：/, '職業：'), law: '國民法官法第14條', doc: '服務證明或在職證明' };
      return result('cannot', [job], ['請在調查表第 14 條勾選對應的職業，並寫出服務機關。', '如果只是同機關的約聘、外包或助理，不一定算，請勾「不確定」並寫明職務內容。'], ['Q3606', 'A012', 'A017'], s);
    }
    if (r && r['類型'] === '得拒絕') {
      var k = /年滿七十/.test(r['對應事由']) ? 1 : /曾於5年內/.test(r['對應事由']) ? 9 : /老師|教師|任教/.test(s) ? 2 : 3;
      var tips = k === 9 ? ['寫出上次擔任的年份和法院，法院會調閱紀錄。']
        : k === 1 ? ['年齡以通知書送達那天計算。']
        : ['補習班、安親班不是學校，通常不算；在職專班、空大如果是已立案學校，可能算。'];
      return result('may', [item(k)], tips, ['Q3607', 'A013', 'A016'], s);
    }

    // 第二層：要法院判斷「重大」「顯有困難」的幾款
    var items = [], tips = [];
    var others = /母親|父親|媽|爸|奶奶|爺爺|外婆|外公|阿嬤|阿公|婆婆|公公|岳母|岳父|小孩|孩子|兒子|女兒|寶寶|嬰兒|家人|先生|太太|老公|老婆|配偶|丈夫|妻子/.test(s);
    if (CARE.test(s) || (others && ILL.test(s))) {
      items.push(item(6));
      tips.push('寫清楚照顧誰、他現在的狀況，以及照顧需要你多少時間。');
      if (!ALONE.test(s)) tips.push('說明為什麼沒有其他人可以代替你（例如家裡只有你一個人）。');
      tips.push('如果你其實願意參加，可以在調查表勾選需要的照護、托育協助，法院會幫忙安排（Q3635）。');
    } else if (ILL.test(s)) {
      items.push(item(4));
      tips.push('寫出病名或治療（例如手術日期、住院、化療期間），以及醫師的建議。');
    } else if (VAGUE_ILL.test(s)) {
      return result('more', [], ['只寫「身體不好」法院很難判斷。請寫出病名或正在接受的治療（例如手術、住院、復健），並準備診斷證明書。'], ['A013', 'A017'], s);
    }
    if (DISASTER.test(s)) { items.push(item(7)); tips.push('寫出受災的時間、地點和目前正在處理的事。'); }
    if (RECENT.test(s)) { items.push(item(10)); tips.push('寫出上次被通知到庭的日期和法院。'); }
    if (NEED.test(s) && !items.length) {
      items.push(item(8));
      tips.push('第 8 款要「重大需要」：只寫「工作很忙」「收入會減少」通常不夠，請具體說明那段期間為什麼無法到庭。');
      tips.push('雇主必須給公假，也不能因此處分你（Q3638）；到庭可領日費 1,500 元，另有交通費（Q3637）。');
    }
    if (items.length) return result('judge', items, tips, ['Q3607', 'A013', 'A016', 'A017'], s);

    var noneTips = others ? ['說明裡提到的家人身分（例如家人是警察、學生、70 歲）不算你自己的事由；照顧家人才可能適用第 6 款。'] : [];
    return result('none', [], noneTips.concat([
      '原則上應依通知到庭。沒有正當理由不到，法院可以處新臺幣 3 萬元以下罰鍰（Q3607）。',
      '到庭可領日費 1,500 元，另有交通費（Q3637）；雇主必須給公假（Q3638）。',
      '如果有其他特殊狀況，可以在調查表勾「不確定」並寫下來，由法院判斷（A017）。'
    ]), ['Q3607', 'Q3637', 'Q3638', 'A017'], s);
  }

  var TITLES = {
    cannot: '可能符合「不得擔任」',
    may: '可能符合「得拒絕」',
    judge: '可能符合「得拒絕」，要由法院判斷是否「重大」',
    none: '看起來不符合免除事由',
    more: '還需要多一點資訊'
  };

  function result(verdict, items, tips, cites, s) {
    return { verdict: verdict, title: TITLES[verdict], items: items, tips: tips, cites: cites, draft: draft(verdict, items, s) };
  }

  /**
   * 說明草稿：照固定格式套用民眾自己寫的內容，不會替他編造事實。
   * 姓名、編號用 ○○○ 代替，請民眾自己填。
   */
  function draft(verdict, items, s) {
    if (!items.length || !s) return '';
    var why = items.map(function (x) { return x.label; }).join('；');
    var law = items.map(function (x) { return x.law.replace('國民法官法', ''); }).join('、');
    var docs = items.map(function (x) { return x.doc; }).filter(Boolean);
    return '本人○○○（候選人編號○○○）收到候選國民法官通知。因' + why + '，依國民法官法' + law +
      (verdict === 'cannot' ? '，應屬不得擔任國民法官之情形。' : '，申請拒絕擔任國民法官。') +
      '\n具體情形：' + s.replace(/[。.]?$/, '。') +
      (docs.length ? '\n檢附' + docs.join('、') + '供參。' : '') +
      '\n是否准許，敬請法院審酌。';
  }

  /* ------------------------------------------------------------------
   * 專屬準備清單
   * ------------------------------------------------------------------ */

  /** 身分：[代號, 顯示文字, 相關題號] */
  var ROLES = [
    ['office', '上班族', ['Q3638', 'Q3637']],
    ['self', '自營商、攤販、接案', ['Q3637', 'Q3616']],
    ['student', '學生', ['A013', 'A015', 'A016']],
    ['teacher', '老師', ['A013', 'A015', 'A016']],
    ['civil', '公務員、醫護人員', ['A014', 'A012']],
    ['home', '家管、要照顧家人', ['Q3635', 'A013']],
    ['senior', '70 歲以上', ['A013', 'A016']],
    ['other', '其他', []]
  ];
  /** 擔心的事：[代號, 顯示文字, 相關題號] */
  var WORRIES = [
    ['leave', '請假會被扣薪嗎', ['Q3638']],
    ['money', '去一天有錢領嗎', ['Q3637']],
    ['law', '聽不懂法律、案情', ['Q3608', 'Q3619', 'Q3618']],
    ['safety', '被告會不會找上我', ['Q3639', 'Q3640']],
    ['care', '家裡有人要照顧', ['Q3635']],
    ['far', '住得很遠', ['Q3636']],
    ['time', '要花多少時間', ['Q3611', 'Q3616']],
    ['wrong', '怕判錯、壓力大', ['Q3626', 'Q3624', 'Q3641']],
    ['skip', '不回覆會怎樣', ['A003', 'Q3613']]
  ];
  /** 每份清單最後都附的「下一步」 */
  var NEXT = ['Q3612', 'A017'];
  var MAX_CARDS = 6;

  /**
   * @param {string} role       ROLES 的代號
   * @param {string[]} worries  WORRIES 的代號
   * @param {Array<{id,q,a,src}>} entries  QASearch.parseEntries 的結果
   * @returns {{cards:Array<{id,q,a,src}>, next:Array<{id,q,a,src}>}}
   */
  function buildGuide(role, worries, entries) {
    var byId = {};
    (entries || []).forEach(function (e) { byId[e.id] = e; });
    var ids = [];
    var add = function (list) { list.forEach(function (id) { if (ids.indexOf(id) < 0 && NEXT.indexOf(id) < 0) ids.push(id); }); };
    // 擔心的事優先，再補身分相關的題目
    WORRIES.forEach(function (w) { if ((worries || []).indexOf(w[0]) >= 0) add(w[2]); });
    ROLES.forEach(function (r) { if (r[0] === role) add(r[2]); });
    if (!ids.length) add(['Q3617', 'Q3637', 'Q3638']);
    var pick = function (id) { return byId[id]; };
    return { cards: ids.map(pick).filter(Boolean).slice(0, MAX_CARDS), next: NEXT.map(pick).filter(Boolean) };
  }

  return { ART16: ART16, ROLES: ROLES, WORRIES: WORRIES, NEXT: NEXT, checkSituation: checkSituation, buildGuide: buildGuide };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SelfHelp;
