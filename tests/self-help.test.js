// lib/self-help.js：民眾端免除初篩、專屬準備清單（取代 PartyRock 模組 2、3）
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/self-help.js');
const Q = require('../lib/qa-search.js');
const { loadKB } = require('./helpers');

const check = t => H.checkSituation(t, { rocYear: 115 });

// 模組 3 原本的 5 題測試題（prompts/模組3_免除初篩設定.txt 第 4 步），加上幾個邊界
const CASES = [
  ['我是大學三年級學生', 'may', '第16條第3款'],
  ['我是現役警察', 'cannot', '第14條'],
  ['我要照顧中風的爸爸，家裡沒有其他人', 'judge', '第16條第6款'],
  ['我覺得很麻煩不想去', 'none', ''],
  ['我最近心情不太好', 'more', ''],
  ['我今年 72 歲', 'may', '第16條第1款'],
  ['民國 40 年次', 'may', '第16條第1款'],
  ['我在國小當老師', 'may', '第16條第2款'],
  ['下個月要開心臟手術，要住院兩週', 'judge', '第16條第4款'],
  ['我是夜市攤販，那幾天沒辦法擺攤', 'judge', '第16條第8款'],
  ['家裡上個月淹水全毀', 'judge', '第16條第7款'],
  ['我先生是警察', 'none', ''],          // 家人的職業不算自己的事由
  ['照顧 85 歲的母親', 'judge', '第16條第6款'], // 家人的年齡不算第 1 款
  ['嗨', 'more', ''],
];
for (const [text, verdict, law] of CASES) {
  test(`checkSituation：「${text}」→ ${verdict} ${law}`, () => {
    const r = check(text);
    assert.equal(r.verdict, verdict);
    if (law) assert.ok(r.items.some(i => i.law.includes(law)), JSON.stringify(r.items));
    else assert.equal(r.items.length, 0);
    assert.ok(r.cites.length > 0, '每個結果都要附出處');
  });
}

test('checkSituation：只有符合事由才產生說明草稿，草稿不放姓名、用民眾原文', () => {
  const r = check('我要照顧中風的爸爸，家裡沒有其他人');
  assert.match(r.draft, /○○○/);
  assert.match(r.draft, /我要照顧中風的爸爸，家裡沒有其他人。/);
  assert.match(r.draft, /是否准許，敬請法院審酌/);
  assert.equal(check('我覺得很麻煩不想去').draft, '');
  assert.equal(check('我最近心情不太好').draft, '');
});

test('checkSituation：結果用「可能符合」，不替法院下決定', () => {
  for (const [t] of CASES) {
    const r = check(t);
    assert.doesNotMatch(r.title + r.tips.join(''), /准許你|一定可以|核准/);
  }
});

test('checkSituation：輸入過長會截斷，不會出錯', () => {
  const r = check('我是學生'.repeat(400));
  assert.ok(r.draft.length < 800);
});

test('buildGuide：引用的題號都在問答資料庫裡', () => {
  const { KB, ALT } = loadKB();
  const ids = new Set(Q.parseEntries(KB, ALT).map(e => e.id));
  const all = [...H.NEXT, ...H.ROLES.flatMap(r => r[2]), ...H.WORRIES.flatMap(w => w[2]), 'Q3617', 'Q3637', 'Q3638'];
  for (const id of all) assert.ok(ids.has(id), `${id} 不在資料庫`);
  for (const k in H.ART16) assert.ok(H.ART16[k][1].startsWith('國民法官法第16條第'));
});

test('buildGuide：擔心的事優先、不重複、最多 6 題，最後附下一步', () => {
  const { KB, ALT } = loadKB();
  const entries = Q.parseEntries(KB, ALT);
  const g = H.buildGuide('office', ['money', 'leave', 'law', 'safety', 'far'], entries);
  assert.equal(g.cards[0].id, 'Q3638'); // WORRIES 的順序：請假在前
  assert.ok(g.cards.length <= 6);
  assert.equal(new Set(g.cards.map(c => c.id)).size, g.cards.length);
  assert.deepEqual(g.next.map(c => c.id), H.NEXT);
  assert.ok(g.cards.every(c => c.a && c.src), '只用資料庫原文');
  const empty = H.buildGuide('', [], entries);
  assert.ok(empty.cards.length > 0, '什麼都沒選也有基本題目');
});
