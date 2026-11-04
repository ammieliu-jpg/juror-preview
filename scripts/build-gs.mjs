// 把 lib/screening.js 和 apps-script/main.gs 合併成 apps-script/Code.gs（貼進 Apps Script 的就是這個檔）。
// 用法：npm run build:gs　　檢查是否同步：node scripts/build-gs.mjs --check
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = readFileSync(join(root, 'lib/screening.js'), 'utf8')
  // Apps Script 沒有 module，這一行在那裡沒有作用，拿掉比較乾淨
  .replace(/\nif \(typeof module[^\n]*\n?$/, '\n');
const main = readFileSync(join(root, 'apps-script/main.gs'), 'utf8');
const out = `// ⚠ 自動產生的檔案，請勿手動修改。來源：lib/screening.js + apps-script/main.gs（npm run build:gs）
// 使用方式：Apps Script 編輯器 → 刪掉原本內容 → 貼上本檔全部內容 → 儲存。

${main}

/* ======================================================================
 * 以下為 lib/screening.js（和 court.html 共用的初篩邏輯）
 * ====================================================================== */
${lib}`;
const target = join(root, 'apps-script/Code.gs');
if (process.argv.includes('--check')) {
  const cur = (() => { try { return readFileSync(target, 'utf8'); } catch { return ''; } })();
  if (cur !== out) { console.error('apps-script/Code.gs 和原始碼不同步，請執行 npm run build:gs'); process.exit(1); }
  console.log('apps-script/Code.gs 已同步');
} else {
  writeFileSync(target, out);
  console.log('已產生 apps-script/Code.gs');
}
