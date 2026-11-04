// lib/qa-search.js 的單元測試：用 index.html 裡真正的 42 題資料庫
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../lib/qa-search.js');
const { loadKB } = require('./helpers.js');

const { KB, ALT } = loadKB();
const entries = Q.parseEntries(KB, ALT);

test('資料庫解析出 41 題司法院常見問答＋20 題補充，題號不重複，每題都有出處', () => {
  assert.equal(entries.filter(e => e.id.startsWith('Q')).length, 41);
  assert.equal(entries.filter(e => e.id.startsWith('A')).length, 20);
  assert.equal(new Set(entries.map(e => e.id)).size, entries.length);
  for (const e of entries) {
    assert.ok(e.q && e.a, e.id + ' 缺題目或答案');
    assert.ok(e.src, e.id + ' 缺出處');
  }
});

test('bigrams：去標點、去停用詞', () => {
  assert.deepEqual([...Q.bigrams('去一天，多少錢？')], ['去一', '一天', '天多', '多少', '少錢']);
  assert.ok(!Q.bigrams('國民法官可以').has('可以'));
});

// 民眾常問的口語問法 → 應該找到的題號。新增口語問法（MORE_ALT）時，把例子加在這裡當回歸測試。
const CASES = [
  ['去一天有多少錢？', 'Q3637'],
  ['可以請公假嗎？', 'Q3638'],
  ['被告會不會來找我？', 'Q3639'],
  ['我是學生可以拒絕嗎？', 'Q3607'],
  ['住很遠交通費誰出', 'Q3636'],
];
for (const [q, id] of CASES) {
  test(`關鍵字比對：「${q}」→ ${id}`, () => {
    const r = Q.bestKeyword(entries, q);
    assert.equal(r.entry && r.entry.id, id, `實際找到 ${r.entry && r.entry.id}（${r.entry && r.entry.q}）分數 ${r.score.toFixed(2)}`);
    assert.match(Q.keywordAnswer(entries, q), /出處：/);
  });
}

test('資料庫沒有的問題要說「沒有收錄」，不可以亂配', () => {
  assert.equal(Q.keywordAnswer(entries, '今天天氣如何'), Q.NOT_FOUND);
});

test('閒聊不拿去比對', () => {
  assert.match(Q.chatReply('你好！'), /你好/);
  assert.match(Q.chatReply('你是誰?'), /小幫手/);
  assert.equal(Q.chatReply('去一天多少錢'), null);
});

test('hybridAnswer：語意分數不夠高時加上「不太確定」', () => {
  const [a, b] = entries;
  const sure = Q.hybridAnswer(entries, new Map([[a, 0.9], [b, 0.5]]), '隨便');
  assert.ok(sure.startsWith('最接近的問題是'));
  const unsure = Q.hybridAnswer(entries, new Map([[a, 0.65], [b, 0.6]]), '隨便');
  assert.ok(unsure.startsWith('我不太確定'));
  assert.equal(Q.hybridAnswer(entries, new Map([[a, 0.3]]), '隨便'), Q.NOT_FOUND);
});

test('needsPersonalHelp：個人狀況要附免除初篩、準備清單', () => {
  assert.ok(Q.needsPersonalHelp('我是老師可以不去嗎', ''));
  assert.ok(!Q.needsPersonalHelp('去一天多少錢', '日費 1,500 元'));
});
