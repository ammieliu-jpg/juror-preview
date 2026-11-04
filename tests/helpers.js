// 測試共用：從 index.html 取出問答資料庫（KB、ALT、MORE_ALT），不必另存一份
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadKB() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const pick = (name) => {
    const m = html.match(new RegExp('^const ' + name + ' = (.+);$', 'm'));
    if (!m) throw new Error('index.html 找不到 ' + name);
    return JSON.parse(m[1]);
  };
  const KB = pick('KB');
  const ALT = pick('ALT');
  // MORE_ALT 是一般 JS 物件字面值，用 vm 執行那一段
  const more = html.match(/const MORE_ALT = (\{[\s\S]*?\n\});/);
  const MORE_ALT = vm.runInNewContext('(' + more[1] + ')');
  for (const k in MORE_ALT) ALT[k] = (ALT[k] ? ALT[k] + '｜' : '') + MORE_ALT[k];
  return { KB, ALT };
}
module.exports = { loadKB };
