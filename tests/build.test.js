// apps-script/Code.gs 是由原始碼合併產生的；忘了重新產生就會失敗，提醒要執行 npm run build:gs
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('apps-script/Code.gs、PublicAI.gs 和原始碼同步', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-gs.mjs'), '--check'], { stdio: 'pipe' }));
});

test('court.html 與 index.html 載入的 lib 檔案都存在', () => {
  const fs = require('node:fs');
  for (const f of ['court.html', 'index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const m of html.matchAll(/<script src="([^":]+)"/g)) assert.ok(fs.existsSync(path.join(__dirname, '..', m[1])), `${f} 引用的 ${m[1]} 不存在`);
  }
});
