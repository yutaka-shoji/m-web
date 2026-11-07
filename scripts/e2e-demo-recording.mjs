// End-to-end recording check with demo loggers (no Bluetooth needed):
// add 3 demo loggers → start recording through the UI → wait → stop (confirm dialog) →
// Data page → download the ZIP → unzip and check the CSV files.
//
// Prerequisite: `npm run dev`. Usage: node scripts/e2e-demo-recording.mjs [seconds=40]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import puppeteer from 'puppeteer-core';

const SECONDS = Number(process.argv[2] ?? 40);
const PORT = Number(process.env.CDP_PORT ?? 9336);
const URL = process.env.APP_URL ?? 'http://localhost:5173/#/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'mweb-rec-'));
const downloads = mkdtempSync(join(tmpdir(), 'mweb-dl-'));
execFileSync('open', ['-na', 'Google Chrome', '--args', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--lang=ja', URL]);

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
try {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith(URL.replace(/#.*$/, '')));
    if (!page) await sleep(250);
  }
  await page.bringToFront();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

  await page.waitForSelector('[data-testid="add-device-empty"]');
  await page.click('[data-testid="add-demo-empty"]');
  await page.waitForFunction(
    () => window.__mwebDevices.entries.length === 3 && window.__mwebDevices.entries.every((e) => e.state.value.conn.state === 'online'),
    { timeout: 30000 },
  );
  ok('3 demo loggers online');

  await page.type('#rec-title', 'E2E 記録テスト');
  await page.click('[data-testid="start-recording"]');
  await page.waitForSelector('[data-testid="stop-recording"]', { timeout: 20000 });
  ok('recording started');
  await sleep(SECONDS * 1000);
  const samples = await page.evaluate(() => window.__mwebRecording.samples);
  ok('samples recorded', { samples });

  await page.click('[data-testid="stop-recording"]');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog[open] button[type="submit"]');
  await page.waitForSelector('[data-testid="start-recording"]', { timeout: 20000 });
  await page.waitForFunction(() => window.__mwebDevices.entries.every((e) => e.state.value.logging === false), {
    timeout: 20000,
  });
  const logging = await page.evaluate(() => window.__mwebDevices.entries.map((e) => e.state.value.logging));
  ok('recording stopped, devices stopped', { logging });

  await page.goto(URL.replace('#/', '#/data'));
  await page.waitForSelector('table');
  const before = new Set(readdirSync(downloads));
  await page.click('[data-testid="download"]');
  let file;
  for (let i = 0; i < 60 && !file; i++) {
    await sleep(500);
    file = readdirSync(downloads).find((f) => !before.has(f) && f.endsWith('.zip'));
  }
  if (!file) throw new Error('ZIP was not downloaded');
  const entries = unzipSync(readFileSync(join(downloads, file)));
  const names = Object.keys(entries);
  const csvs = names.filter((n) => n.endsWith('.csv'));
  const first = strFromU8(entries[csvs[0]]);
  const lines = first.split('\r\n').filter(Boolean);
  const manifest = JSON.parse(strFromU8(entries['session.json']));
  ok('zip downloaded', { file, names, rowsInFirstCsv: lines.length - 1, header: lines[0], sample: lines[Math.min(5, lines.length - 1)] });
  const raw = entries[csvs[0]];
  if (!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)) throw new Error('CSV has no UTF-8 BOM');
  // (TextDecoder already removed the BOM from `first`)
  if (!lines[0].startsWith('datetime,unix_time,t_dry[C]')) throw new Error('unexpected CSV header');
  if (csvs.length !== 3) throw new Error(`expected 3 CSV files, got ${csvs.length}`);
  if (manifest.devices.length !== 3) throw new Error('manifest devices');
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = String(e);
  console.error('✗', e);
} finally {
  const dir = join(import.meta.dirname, '..', 'tests', 'hw', 'out');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `e2e-recording-${Date.now()}.json`), JSON.stringify(report, null, 2));
  await browser?.close().catch(() => {});
}
