// Device drawer E2E with a demo logger: settings round trip, flash download + CSV, correction
// load/save, CO2 calibration progress, rename, erase. Saves screenshots of the drawer.
// Prerequisite: `npm run dev`. Usage: node scripts/e2e-demo-drawer.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = Number(process.env.CDP_PORT ?? 9338);
const URL = process.env.APP_URL ?? 'http://localhost:5173/#/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = join(import.meta.dirname, '..', 'tests', 'hw', 'out');
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'mweb-drawer-'));
const downloads = mkdtempSync(join(tmpdir(), 'mweb-drawer-dl-'));
execFileSync('open', ['-na', 'Google Chrome', '--args', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000', '--lang=ja', URL]);
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {
    await sleep(250);
  }
}
const report = { steps: [] };
const ok = (name, data) => {
  report.steps.push({ name, ...data });
  console.log(`✓ ${name}`, data ? JSON.stringify(data) : '');
};
let page;
const clickText = (scope, text) =>
  page.evaluate(
    (sc, tx) => {
      const b = [...document.querySelectorAll(`${sc} button`)].find((x) => x.textContent.trim().startsWith(tx));
      if (!b) throw new Error(`button not found: ${tx}`);
      b.click();
    },
    scope,
    text,
  );
try {
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith(URL.replace(/#.*$/, '')));
    if (!page) await sleep(250);
  }
  await page.bringToFront();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.evaluate(() => localStorage.setItem('m-web.locale', 'ja'));
  await page.reload();
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await page.waitForSelector('[data-testid="add-demo-empty"]');
  await page.click('[data-testid="add-demo-empty"]');
  await page.waitForFunction(() => window.__mwebDevices.entries.every((e) => e.state.value.conn.state === 'online') && window.__mwebDevices.entries.length === 3, { timeout: 30000 });
  await page.click('[data-testid="device-details"]');
  await page.waitForSelector('.panel');
  await sleep(800);
  await page.screenshot({ path: join(outDir, 'drawer-1.png') });
  ok('drawer open');

  // settings round trip: velocity interval 30 s
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.panel input[type="number"]')];
    inputs[1].value = '30';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText('.panel .sec:nth-of-type(2)', '機器に送信');
  await page.waitForFunction(() => window.__mwebDevices.entries[0].state.value.meta.settings.velocity.interval === 30, { timeout: 10000 });
  ok('settings sent (velocity 30 s)');

  // flash download (demo: 2880 records)
  await clickText('.panel .sec:nth-of-type(3)', '吸い出す');
  await page.waitForFunction(() => window.__mwebDevices.entries[0].state.value.op === 'dump', { timeout: 10000 });
  await sleep(3000);
  await page.screenshot({ path: join(outDir, 'drawer-2-download.png') });
  await page.waitForFunction(() => window.__mwebDevices.entries[0].state.value.op === null, { timeout: 120000 });
  ok('flash download finished');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.panel button')].some((b) => b.textContent.trim().startsWith('CSV を保存')),
    { timeout: 10000 },
  );
  const before = new Set(readdirSync(downloads));
  await clickText('.panel .sec:nth-of-type(3)', 'CSV を保存');
  let file;
  for (let i = 0; i < 40 && !file; i++) {
    await sleep(300);
    file = readdirSync(downloads).find((f) => !before.has(f) && f.endsWith('.csv'));
  }
  const lines = readFileSync(join(downloads, file), 'utf8').split('\r\n').filter(Boolean);
  ok('flash CSV saved', { file, rows: lines.length - 1, second: lines[1] });

  // correction: load, change humidity b, send
  await clickText('.panel .sec:nth-of-type(4)', '読み込む');
  await page.waitForSelector('.panel .sec:nth-of-type(4) table');
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.panel .sec:nth-of-type(4) tbody tr');
    const b = rows[1].querySelectorAll('input')[1];
    b.value = '-0.5';
    b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText('.panel .sec:nth-of-type(4)', '機器に送信');
  await page.waitForFunction(() => document.querySelector('.panel .sec:nth-of-type(4) .msg.ok'), { timeout: 10000 });
  ok('correction sent');

  // CO2 forced calibration (demo: 35 s)
  await clickText('.panel .sec:nth-of-type(5)', '校正を開始');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog[open] button[type="submit"]');
  await page.waitForFunction(() => window.__mwebDevices.entries[0].state.value.op === 'co2cal', { timeout: 10000 });
  await sleep(4000);
  await page.screenshot({ path: join(outDir, 'drawer-3-co2.png') });
  await page.waitForFunction(() => window.__mwebDevices.entries[0].state.value.op === null, { timeout: 60000 });
  const co2msg = await page.$eval('.panel .sec:nth-of-type(5) .msg[role="status"]', (e) => e.textContent);
  ok('co2 calibration done', { co2msg });

  // rename
  await page.evaluate(() => {
    const input = document.querySelector('.panel .sec:nth-of-type(6) input[type="text"]');
    input.value = 'MLogger_会議室';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText('.panel .sec:nth-of-type(6)', '変更');
  await page.waitForFunction(() => window.__mwebDevices.entries[0].state.value.meta.name === 'MLogger_会議室', { timeout: 10000 });
  ok('renamed');

  // erase device memory (typed confirmation)
  await clickText('.panel .sec:nth-of-type(3)', '本体のデータを消去');
  await page.waitForSelector('dialog[open]');
  const disabledBefore = await page.$eval('dialog[open] button[type="submit"]', (b) => b.disabled);
  await page.type('dialog[open] input[type="text"]', 'MLogger_会議室');
  await page.click('dialog[open] button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('.panel .sec:nth-of-type(3) .msg.ok'), { timeout: 10000 });
  ok('erased', { confirmWasDisabledBeforeTyping: disabledBefore });
  await page.screenshot({ path: join(outDir, 'drawer-4-end.png') });
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = String(e);
  console.error('✗', e);
  await page?.screenshot({ path: join(outDir, 'drawer-error.png') }).catch(() => {});
} finally {
  writeFileSync(join(outDir, `e2e-drawer-${Date.now()}.json`), JSON.stringify(report, null, 2));
  await browser?.close().catch(() => {});
}
