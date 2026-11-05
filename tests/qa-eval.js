#!/usr/bin/env node
/**
 * 問答小幫手評估：npm run eval:qa
 * ==================================
 *
 * 在 tests/fixtures/qa-questions.json（55 題換過說法的問題＋10 題資料庫沒有的問題）上比較三種做法：
 *   keyword：只用關鍵字（雙字詞）比對，不下載任何模型
 *   bge：目前的語意模型 Xenova/bge-small-zh-v1.5（北京智源研究院）＋關鍵字混合
 *   e5：替代候選 Xenova/multilingual-e5-small（微軟）＋關鍵字混合
 *
 * 指標：
 *   答對：分數過門檻、而且是對的題目
 *   答錯：分數過門檻、卻配到別題（最糟：民眾會看到不相干的答案）
 *   該拒答卻回答：資料庫沒有的問題，卻配了一題
 *
 * 語意模型要從 Hugging Face 下載，需要網路與 @huggingface/transformers：
 *   npm i --no-save @huggingface/transformers@3.0.2 && npm run eval:qa
 * 只比關鍵字（不用網路）：node tests/qa-eval.js --keyword-only
 */
const fs = require('node:fs');
const path = require('node:path');
const Q = require('../lib/qa-search.js');
const { loadKB } = require('./helpers');
const { questions } = require('./fixtures/qa-questions.json');

const { KB, ALT } = loadKB();
const entries = Q.parseEntries(KB, ALT);
const inScope = questions.filter(x => x.expect), outScope = questions.filter(x => !x.expect);

const MODELS = {
  bge: { id: 'Xenova/bge-small-zh-v1.5', pooling: 'cls', prefix: '' },
  e5: { id: 'Xenova/multilingual-e5-small', pooling: 'mean', prefix: 'query: ' }, // e5 要加前綴；問題對問題屬於對稱比對，兩邊都用 query:
};

/** 每題的最佳候選：[{x, top, score}] */
function keywordPicks() {
  return questions.map(x => { const r = Q.bestKeyword(entries, x.q); return { x, top: r.entry, score: r.score }; });
}

async function semanticPicks(T, m) {
  const ext = await T.pipeline('feature-extraction', m.id, { dtype: 'q8' });
  const embed = async list => {
    const out = [];
    for (let i = 0; i < list.length; i += 16) {
      const t = await ext(list.slice(i, i + 16).map(s => m.prefix + s), { pooling: m.pooling, normalize: true });
      const d = t.dims[1];
      for (let k = 0; k < t.dims[0]; k++) out.push(t.data.slice(k * d, (k + 1) * d));
    }
    return out;
  };
  // 和 index.html 一樣：每一題取「題目＋口語問法」裡最像的那一句
  const texts = [];
  entries.forEach(e => [e.q, ...e.alt.split('｜')].filter(Boolean).forEach(s => texts.push([e, s])));
  const vecs = await embed(texts.map(t => t[1]));
  const qv = await embed(questions.map(x => x.q));
  return questions.map((x, i) => {
    const best = new Map();
    texts.forEach(([e], j) => { let s = 0; const a = qv[i], b = vecs[j]; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; if (s > (best.get(e) || -1)) best.set(e, s); });
    const [top] = Q.hybridRank(entries, best, x.q);
    return { x, top: top ? top[0] : null, score: top ? top[1] : 0 };
  });
}

function measure(picks, th) {
  const ok = p => p.top && p.x.expect.includes(p.top.id);
  const ins = picks.filter(p => p.x.expect), outs = picks.filter(p => !p.x.expect);
  return {
    top1: ins.filter(ok).length,
    correct: ins.filter(p => p.score >= th && ok(p)).length,
    wrong: ins.filter(p => p.score >= th && !ok(p)).length,
    outWrong: outs.filter(p => p.score >= th).length,
  };
}

/** 門檻掃描：答錯和「該拒答卻回答」各扣 3 分。只是參考：門檻是在同一份題目上挑的。 */
function bestThreshold(picks, from, to) {
  let best = null;
  for (let th = from; th <= to + 1e-9; th += 0.01) {
    const m = measure(picks, th), v = m.correct - 3 * (m.wrong + m.outWrong);
    if (!best || v > best.v) best = { th: +th.toFixed(2), v, m };
  }
  return best;
}

function report(name, picks, th, note) {
  const m = measure(picks, th);
  console.log(`${name.padEnd(30)} 門檻 ${th.toFixed(2)}｜排第一的對 ${m.top1}/${inScope.length}｜答對 ${m.correct}｜答錯 ${m.wrong}｜該拒答卻回答 ${m.outWrong}/${outScope.length}${note ? '｜' + note : ''}`);
  return m;
}

function misses(name, picks, th) {
  const bad = picks.filter(p => (p.x.expect ? p.score >= th && !(p.top && p.x.expect.includes(p.top.id)) : p.score >= th));
  if (!bad.length) return;
  console.log(`  ${name} 答錯／不該回答的：`);
  bad.forEach(p => console.log(`    「${p.x.q}」→ ${p.top ? p.top.id + ' ' + p.top.q.slice(0, 18) : '—'}（${p.score.toFixed(3)}），應為 ${p.x.expect ? p.x.expect.join('/') : '沒有收錄'}`));
}

function sizes(dir) {
  const out = {};
  const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(f => {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (/\.onnx$/.test(f.name)) out[path.relative(dir, p)] = (fs.statSync(p).size / 1048576).toFixed(1) + ' MB';
  });
  walk(dir);
  return out;
}

(async () => {
  console.log(`題目：資料庫有答案 ${inScope.length} 題、沒有收錄 ${outScope.length} 題；資料庫 ${entries.length} 題\n`);
  const kw = keywordPicks();
  report('keyword（只用關鍵字）', kw, Q.KEYWORD_MIN, '目前模型載入前的做法');
  if (process.argv.includes('--keyword-only')) { misses('keyword', kw, Q.KEYWORD_MIN); return; }

  const T = await import('@huggingface/transformers');
  T.env.cacheDir = path.join(__dirname, '..', '.cache-models');
  const results = { keyword: kw };
  for (const [k, m] of Object.entries(MODELS)) {
    const t0 = Date.now();
    results[k] = await semanticPicks(T, m);
    console.log(`（${k} 載入與計算 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  }
  console.log('');
  report('bge（目前，門檻 0.60）', results.bge, Q.SEM_MIN, 'index.html 目前的設定');
  const bb = bestThreshold(results.bge, 0.4, 0.95);
  report('bge（掃描最佳門檻）', results.bge, bb.th);
  const be = bestThreshold(results.e5, 0.6, 0.98);
  report('e5（掃描最佳門檻）', results.e5, be.th, 'e5 的分數普遍偏高，0.60 不適用');
  console.log('');
  misses('keyword', kw, Q.KEYWORD_MIN);
  misses('bge', results.bge, Q.SEM_MIN);
  misses('e5', results.e5, be.th);
  console.log('\n模型檔大小：', sizes(T.env.cacheDir));
  console.log('\n注意：門檻是在同一份題目上掃描的，正式採用前要再用另一份題目確認。');
})().catch(err => { console.error(err); process.exitCode = 1; });
