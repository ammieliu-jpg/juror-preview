// 瀏覽器測試：用真的 Chromium 打開網頁、用手機尺寸操作一遍。
// 單元測試（tests/*.test.js）不開瀏覽器，畫面問題（例如勾選框看起來全都勾了）考不出來，所以另外寫這份。
//
// 執行：npm run test:browser
// 需要 Playwright（不放進 package.json，平常的 npm test 仍然不用安裝任何套件）：
//   npm i --no-save playwright@1.63.0 && npx playwright install chromium
//
// 民眾端：大多數人用手機掃 QR code，但也有人會在電腦上輸入網址，所以手機和筆電尺寸都檢查。
// 法院端是書記官在電腦上用的工作頁：用電腦尺寸檢查，手機上只確認不出錯。
// 外部網路（字型、語意模型）一律擋掉：測試不靠網路，問答會走關鍵字比對。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PHONES = ['iPhone SE', 'iPhone 13'];
const LAPTOP = { viewport: { width: 1366, height: 768 } };
/** 民眾端要檢查的裝置：[名稱, 裝置, 是否觸控（觸控才檢查按鈕和選項夠不夠大）] */
const PUBLIC_DEVICES = [['iPhone SE', 'iPhone SE', true], ['iPhone 13', 'iPhone 13', true], ['筆電 1366×768', LAPTOP, false]];

let server, base, browser;

test.before(async () => {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  server?.close();
});

/** 開一個分頁；外部網路擋掉，頁面上的 JavaScript 錯誤收集在 page.errors。 */
async function open(device, file, opts = {}) {
  const ctx = await browser.newContext({ ...(typeof device === 'string' ? devices[device] : device), reducedMotion: 'reduce', ...opts });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(base + file);
  return page;
}

/** 遊戲目前的狀態：有沒有文件視窗、選項、對話文字。 */
const state = p => p.evaluate(() => {
  const doc = document.getElementById('doc');
  return {
    modal: !document.getElementById('modal').hidden,
    hold: !!doc.querySelector('#hold'),
    reply: !!doc.querySelector('#rpNext'),
    seal: !!doc.querySelector('.seal'),
    close: [...doc.querySelectorAll('[data-close]')].map(b => b.dataset.close),
    choices: [...document.querySelectorAll('#choices button')].map(b => b.textContent),
    text: document.getElementById('text').textContent,
    stage: document.getElementById('stage').textContent,
  };
});
const nextLine = p => p.evaluate(() => document.getElementById('dialog').click());

/** 開著的文件視窗的版面檢查。回傳問題清單，空的才算通過。touch：觸控裝置另外檢查按鈕和選項的大小。 */
const docLayout = (p, touch = true) => p.evaluate(touch => {
  const out = [];
  const shown = el => el.getClientRects().length > 0;
  const doc = document.getElementById('doc');
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`頁面可以左右捲動（${document.documentElement.scrollWidth}px）`);
  for (const el of doc.querySelectorAll('.sub, .fine, .warn, .aicta small')) {
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (shown(el) && fs < 13) out.push(`字太小 ${fs}px：${el.textContent.trim().slice(0, 16)}`);
  }
  for (const el of touch ? doc.querySelectorAll('label') : []) {
    const h = el.getBoundingClientRect().height;
    if (shown(el) && h < 40) out.push(`選項太矮 ${Math.round(h)}px：${el.textContent.trim().slice(0, 16)}`);
  }
  for (const el of doc.querySelectorAll('input[type=checkbox], input[type=radio]')) {
    if (!shown(el)) continue;
    if (getComputedStyle(el).colorScheme !== 'light') out.push(`勾選框不是淺色樣式（沒勾的會顯示成深色方塊）：#${el.id}`);
    if (el.getBoundingClientRect().width < 18) out.push(`勾選框太小：#${el.id}`);
  }
  for (const el of touch ? doc.querySelectorAll('button, a.btn') : []) {
    const h = el.getBoundingClientRect().height;
    if (shown(el) && h < 32) out.push(`按鈕太矮 ${Math.round(h)}px：${el.textContent.trim().slice(0, 16)}`);
  }
  return out;
}, touch);

/* ---------- 民眾端（手機） ---------- */

for (const [name, device, touch] of PUBLIC_DEVICES) {
  test(`民眾端（${name}）：看懂調查表 → 試填，版面與勾選框`, async () => {
    const p = await open(device, 'index.html');
    assert.deepEqual(await docLayout(p, touch), [], '開頭的說明');
    // 掃不了 QR code 的人也要知道怎麼辦
    assert.match(await p.textContent('#doc'), /依通知書上的說明[\s\S]*承辦法院/);
    await p.click('#doc [data-close="reply"]');

    // 調查表說明：勾選後即時初篩
    assert.ok(await p.isVisible('#svOut'), '選「看懂調查表」要先看到逐項說明');
    await p.check('#sv0');
    await p.check('#sv6');
    assert.match(await p.textContent('#svOut'), /不得擔任[\s\S]*得拒絕/);
    assert.deepEqual(await docLayout(p, touch), [], '調查表說明');
    await p.click('#doc [data-close="1"]');

    // 試填表單：勾選不能丟出錯誤（以前調查表的事件會留到這裡）
    assert.ok(await p.isVisible('#rpNext'), '說明之後是試填表單');
    await p.check('#rp1');
    await p.check('#rr3');
    await p.check('#rr6');
    assert.deepEqual(await docLayout(p, touch), [], '試填表單');
    assert.deepEqual(p.errors, []);
    await p.context().close();
  });
}

test('民眾端（iPhone SE）：通知書的印章不蓋住標題', async () => {
  const p = await open('iPhone SE', 'index.html');
  await p.click('#doc [data-close="play"]');
  for (let i = 0; i < 30 && !(await state(p)).seal; i++) { await nextLine(p); await p.waitForTimeout(50); }
  const overlap = await p.evaluate(() => {
    const a = document.querySelector('#doc .seal').getBoundingClientRect(), b = document.querySelector('#doc h3').getBoundingClientRect();
    return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  });
  assert.equal(overlap, false);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

for (const phone of PHONES) {
  test(`民眾端（${phone}）：問答小幫手的回答從開頭顯示`, async () => {
    const p = await open(phone, 'index.html');
    await p.click('#doc [data-close="play"]');
    await p.click('#phoneBtn');
    await p.fill('#phInput', '去一天有多少錢？');
    await p.press('#phInput', 'Enter');
    await p.waitForFunction(() => { const b = [...document.querySelectorAll('#msgs .msg.bot')].pop(); return b && b.textContent !== '……'; });
    const r = await p.evaluate(() => {
      const m = document.getElementById('msgs'), b = [...m.querySelectorAll('.msg.bot')].pop();
      const mr = m.getBoundingClientRect(), br = b.getBoundingClientRect();
      return { top: br.top - mr.top, bottom: br.bottom - mr.top, height: mr.height, text: b.textContent };
    });
    assert.match(r.text, /出處/, '回答要附出處');
    assert.ok(r.top >= -1, '回答的開頭不能捲到看不見');
    assert.ok(r.top <= 40 || r.bottom <= r.height + 1, `回答要從開頭顯示（開頭在 ${Math.round(r.top)}px）`);
    assert.deepEqual(p.errors, []);
    await p.context().close();
  });
}

for (const [name, device] of [['iPhone SE', 'iPhone SE'], ['筆電 1366×768', LAPTOP]]) test(`民眾端（${name}）：從頭玩到結尾，沒有任何錯誤`, async () => {
  const p = await open(device, 'index.html');
  const AVOID = /重播|重新填寫|不表態|再玩一次/; // 會繞回原處的選項
  const stages = new Set();
  let done = false;
  for (let i = 0; i < 1000 && !done; i++) {
    const s = await state(p);
    stages.add(s.stage.slice(0, 9));
    if (/謝謝你走完這次預演/.test(s.text) && s.choices.length) { done = true; break; }
    if (s.modal) {
      if (s.hold) { await p.locator('#hold').dispatchEvent('pointerdown'); await p.waitForTimeout(2600); continue; }
      const pick = s.reply ? '0' : s.close.find(v => v !== 'reply' && v !== '0'); // 試填表單按「取消」
      assert.ok(pick !== undefined, `文件視窗沒有可以關掉的按鈕（${s.stage}）`);
      await p.click(`#doc [data-close="${pick}"]`);
    } else if (s.choices.length) {
      const idx = s.choices.findIndex(t => !AVOID.test(t));
      await p.click(`#choices button:nth-child(${idx + 1})`);
    } else {
      await nextLine(p);
    }
    await p.waitForTimeout(40);
  }
  assert.ok(done, '沒有走到結尾');
  assert.ok(stages.has('STAGE 8/8'), '要經過第 8 關');
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

/* ---------- 法院端：電腦完整檢查，手機只確認不出錯 ---------- */

test('法院端（電腦）：示範資料、附件勾選、摘要', async () => {
  const p = await open({ viewport: { width: 1280, height: 800 } }, 'court.html');
  await p.click('#demo');
  await p.waitForFunction(() => document.querySelectorAll('#rows tr').length === 17);
  assert.equal(await p.locator('.kpi').count(), 7);
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '頁面不能左右捲動');
  assert.equal(await p.isVisible('#verWarn'), false, '示範資料不比對規則版本');
  assert.equal(await p.isVisible('#sheetUrl'), false, '沒選到的資料來源欄位要藏起來');

  const pending = async () => Number(await p.locator('.kpi').last().locator('b').textContent());
  const before = await pending();
  assert.ok(before > 0, '要有「待核對附件」');
  await p.locator('#rows input[data-k]').first().check();
  assert.equal(await pending(), before - 1, '勾「我已看過附件」後待核對少一筆');

  await p.click('#sumBtn');
  assert.match(await p.textContent('#summary'), /^共 17 筆免除申請/);
  assert.doesNotMatch(await p.textContent('#rows'), /可直接送法官/);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test('法院端（iPhone SE）：打得開、不出錯', async () => {
  const p = await open('iPhone SE', 'court.html');
  await p.click('#demo');
  await p.waitForFunction(() => document.querySelectorAll('#rows tr').length === 17);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});
