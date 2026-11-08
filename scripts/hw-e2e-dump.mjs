// Real-device flash download through the device drawer (read-only for the logger: get_count +
// dump; nothing is written or erased). Saves the CSV and checks the row count.
// Prerequisite: `npm run dev`. Usage: node scripts/hw-e2e-dump.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = Number(process.env.CDP_PORT ?? 9339);
const URL = process.env.APP_URL ?? 'http://localhost:5173/#/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = join(import.meta.dirname, '..', 'tests', 'hw', 'out');
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'mweb-hwdump-'));
const downloads = mkdtempSync(join(tmpdir(), 'mweb-hwdump-dl-'));
execFileSync('open', ['-na', 'Google Chrome', '--args', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000', URL]);
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {
    await sleep(250);
  }
}
const report = {};
let page;
try {
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith(URL.replace(/#.*$/, '')));
    if (!page) await sleep(250);
  }
  await page.bringToFront();
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await page.waitForFunction(() => '__mwebDevices' in window, { timeout: 15000 });
  const [prompt] = await Promise.all([page.waitForDevicePrompt({ timeout: 30000 }), page.click('[data-testid="add-device-empty"]')]);
  const dev = await prompt.waitForDevice((d) => d.name?.startsWith('MLogger_') || d.name?.startsWith('XBee3'), { timeout: 20000 });
  await prompt.select(dev);
  await page.waitForFunction(() => window.__mwebDevices.entries[0]?.state.value.conn.state === 'online', { timeout: 60000 });
  const name = await page.evaluate(() => window.__mwebDevices.entries[0].state.value.meta.name);
  if (await page.evaluate(() => window.__mwebDevices.entries[0].state.value.logging)) throw new Error('logger is logging; not touching it');
  await page.click('[data-testid="device-details"]');
  await page.waitForSelector('.panel');
  const count = await page.evaluate(async () => (await window.__mwebDevices.entries[0].controller.call('get_count', undefined)).count);
  const t0 = Date.now();
  await page.waitForFunction(
    () => [...document.querySelectorAll('.panel .sec:nth-of-type(3) button')].some((b) => b.textContent.trim() === '読み出す' || b.textContent.trim() === 'Download'),
    { timeout: 15000 },
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('.panel .sec:nth-of-type(3) button')]
      .find((b) => b.textContent.trim() === '読み出す' || b.textContent.trim() === 'Download')
      .click(),
  );
  await page.waitForFunction(() => window.__mwebDevices.entries[0].state.value.op === 'dump', { timeout: 10000 });
  await sleep(2000);
  await page.screenshot({ path: join(outDir, 'hw-dump-progress.png') });
  await page.waitForFunction(() => window.__mwebDevices.entries[0].state.value.op === null, { timeout: 600000 });
  const seconds = (Date.now() - t0) / 1000;
  await page.waitForFunction(
    () => [...document.querySelectorAll('.panel button')].some((b) => /^(CSV を保存|Save CSV)$/.test(b.textContent.trim())),
    { timeout: 15000 },
  );
  const before = new Set(readdirSync(downloads));
  await page.evaluate(() =>
    [...document.querySelectorAll('.panel button')].find((b) => /^(CSV を保存|Save CSV)$/.test(b.textContent.trim())).click(),
  );
  let file;
  for (let i = 0; i < 60 && !file; i++) {
    await sleep(300);
    file = readdirSync(downloads).find((f) => !before.has(f) && f.endsWith('.csv'));
  }
  const lines = readFileSync(join(downloads, file), 'utf8').split('\r\n').filter(Boolean);
  Object.assign(report, { name, count, seconds: Math.round(seconds), file, rows: lines.length - 1, first: lines[1], last: lines.at(-1) });
  report.ok = lines.length - 1 <= count && lines.length - 1 > 0;
  console.log(report.ok ? '✓' : '✗', JSON.stringify(report));
  await page.evaluate(() => window.__mwebDevices.entries.forEach((e) => e.controller.disconnect()));
} catch (e) {
  report.ok = false;
  report.error = String(e);
  console.error('✗', e);
} finally {
  writeFileSync(join(outDir, `hw-dump-${Date.now()}.json`), JSON.stringify(report, null, 2));
  await browser?.close().catch(() => {});
}
