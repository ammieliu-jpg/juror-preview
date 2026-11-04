// 產生要貼進 Apps Script 的兩個檔案：
//   apps-script/Code.gs      = apps-script/main.gs + lib/screening.js（法院端，模組 6）
//   apps-script/PublicAI.gs  = apps-script/public-ai.gs + index.html 的 DELIB 評議提示詞 + 注入防護（民眾端，模組 5）
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
// 民眾端 AI 代理：評議提示詞以 index.html 的 DELIB 為唯一來源，注入防護沿用 lib/screening.js 的 INJECT
const html = readFileSync(join(root, 'index.html'), 'utf8');
const delib = html.match(/^const DELIB = (".*");$/m);
if (!delib) { console.error('index.html 找不到 const DELIB'); process.exit(1); }
const inject = lib.match(/var INJECT = (\/.*\/[a-z]*);/);
if (!inject) { console.error('lib/screening.js 找不到 INJECT'); process.exit(1); }
const pub = `// ⚠ 自動產生的檔案，請勿手動修改。來源：apps-script/public-ai.gs + index.html 的 DELIB + lib/screening.js 的 INJECT（npm run build:gs）
// 使用方式：開一個新的獨立 Apps Script 專案 → 貼上本檔全部內容 → 儲存 → 部署成網頁應用程式（見 docs/SETUP.md）。

${readFileSync(join(root, 'apps-script/public-ai.gs'), 'utf8')}
/* ======================================================================
 * 以下自動產生：評議提示詞（index.html 的 DELIB）與疑似指令文字（lib/screening.js 的 INJECT）
 * ====================================================================== */
const DELIB_PROMPT = ${delib[1]};
const PUBLIC_INJECT = ${inject[1]};
`;

const outputs = [[join(root, 'apps-script/Code.gs'), out], [join(root, 'apps-script/PublicAI.gs'), pub]];
if (process.argv.includes('--check')) {
  let ok = true;
  for (const [target, text] of outputs) {
    const cur = (() => { try { return readFileSync(target, 'utf8'); } catch { return ''; } })();
    if (cur !== text) { console.error(`${target.replace(root + '/', '')} 和原始碼不同步，請執行 npm run build:gs`); ok = false; }
  }
  if (!ok) process.exit(1);
  console.log('apps-script/Code.gs、PublicAI.gs 已同步');
} else {
  for (const [target, text] of outputs) writeFileSync(target, text);
  console.log('已產生 apps-script/Code.gs、apps-script/PublicAI.gs');
}
