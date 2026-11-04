#!/usr/bin/env node
/**
 * 初篩準確度評估（規則層）：npm run eval
 *
 * 用 tests/fixtures/exemptions.json 的標註資料，算出：
 *   - 覆蓋率：規則層自己判掉幾成（其餘交給 AI，花 token）
 *   - 規則層正確率：規則判的那些，「類型」和人工標註（gold）一致的比例
 *   - 誤放行：規則說「可直接送法官」但標註不是同一類型的件數（這個一定要是 0）
 *
 * AI 層的評估需要金鑰與網路：設定環境變數 GEMINI_API_KEY 後加 --ai 參數，
 * 會把規則判不了的案例送給 Gemini，比較「AI建議／類型」與 gold。只能用虛構資料。
 */
const S = require('../lib/screening.js');
const { cases, rocYear } = require('./fixtures/exemptions.json');

const rows = cases.map(c => ({ c, out: S.ruleClassify(c, { rocYear }) }));
const byRule = rows.filter(r => r.out);
const correct = byRule.filter(r => r.out['類型'] === r.c.gold);
const leaked = byRule.filter(r => r.out['書記官待辦'] === '可直接送法官' && r.out['類型'] !== r.c.gold);

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');
console.log(`標註案例：${cases.length} 筆`);
console.log(`規則層覆蓋率：${byRule.length}/${cases.length}（${pct(byRule.length, cases.length)}），其餘交給 AI`);
console.log(`規則層類型正確率：${correct.length}/${byRule.length}（${pct(correct.length, byRule.length)}）`);
console.log(`誤放行（規則說可直接送法官，但類型錯）：${leaked.length} 筆`);
byRule.filter(r => r.out['類型'] !== r.c.gold).forEach(r => console.log(`  ✗ ${r.c.id}：規則判「${r.out['類型']}」，標註「${r.c.gold}」`));

async function evalAI() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error('要評估 AI 層，請先設定 GEMINI_API_KEY'); process.exit(1); }
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const todo = rows.filter(r => !r.out);
  let ok = 0;
  for (const { c } of todo) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: S.buildPrompt(c) }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }),
    });
    const j = await res.json();
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    let out; try { out = S.finalize(S.checkAI(S.parseJson(text), c), c); } catch (e) { out = { 'AI建議': '解析失敗', '類型': '' }; }
    // gold 是「資料不足」時看 AI建議；其餘看類型
    const hit = c.gold === '資料不足' ? out['AI建議'] === '資料不足' : out['類型'] === c.gold;
    if (hit) ok++;
    console.log(`${hit ? '✓' : '✗'} ${c.id}：AI「${out['類型']}／${out['AI建議']}」，標註「${c.gold}」，需人工確認：${out['需人工確認']}`);
    await new Promise(r => setTimeout(r, 4500)); // 免費額度每分鐘有上限
  }
  console.log(`AI 層正確率：${ok}/${todo.length}（${pct(ok, todo.length)}）`);
}

if (process.argv.includes('--ai')) evalAI();
else if (leaked.length) process.exitCode = 1;
