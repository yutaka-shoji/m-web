// Real-device recording E2E through the app UI (BLE-only: the loggers' flash is not written).
// add every nearby M-Logger → start recording with "also save on flash" unchecked → wait →
// drop one GATT link → automatic reconnect + logging restart → wait → stop (devices too) →
// Data page → ZIP → check the CSV files.
//
// Prerequisite: `npm run dev`. Usage: node scripts/hw-e2e-recording.mjs [secondsPerPhase=60]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import puppeteer from 'puppeteer-core';

const PHASE_S = Number(process.argv[2] ?? 60);
const PORT = Number(process.env.CDP_PORT ?? 9337);
const URL = process.env.APP_URL ?? 'http://localhost:5173/#/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'mweb-hwrec-'));
const downloads = mkdtempSync(join(tmpdir(), 'mweb-hwdl-'));
execFileSync('open', ['-na', 'Google Chrome', '--args', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', URL]);

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {
    await sleep(250);
  }
}
const report = { startedAt: new Date().toISOString(), steps: [] };
const ok = (name, data) => {
  report.steps.push({ t: new Date().toISOString(), name, ...data });
  console.log(`✓ ${name}`, data ? JSON.stringify(data) : '');
};
const states = (page) =>
  page.evaluate(() =>
    window.__mwebDevices.entries.map((e) => ({
      name: e.state.value.meta.name,
      conn: e.state.value.conn.state,
      logging: e.state.value.logging,
      stream: e.state.value.stream,
    })),
  );
async function until(page, pred, label, ms) {
  const t0 = Date.now();
  for (;;) {
    const s = await states(page);
    if (pred(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label} ${JSON.stringify(s)}`);
    await sleep(500);
  }
}

let page;
try {
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith(URL.replace(/#.*$/, '')));
    if (!page) await sleep(250);
  }
  await page.bringToFront();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await page.waitForFunction(() => '__mwebDevices' in window, { timeout: 15000 });

  const used = new Set();
  for (let i = 0; i < 3; i++) {
    const sel = i === 0 ? '[data-testid="add-device-empty"]' : '[data-testid="add-device"]';
    await page.waitForSelector(`${sel}:not([disabled])`, { timeout: 30000 });
    const [prompt] = await Promise.all([page.waitForDevicePrompt({ timeout: 30000 }), page.click(sel)]);
    let dev;
    try {
      dev = await prompt.waitForDevice((d) => (d.name?.startsWith('MLogger_') || d.name?.startsWith('XBee3')) && !used.has(d.id), {
        timeout: 20000,
      });
    } catch {
      await prompt.cancel().catch(() => {});
      break;
    }
    used.add(dev.id);
    await prompt.select(dev);
    await until(page, (s) => s.length === i + 1 && s[i].conn === 'online', `device ${i + 1}`, 60000);
  }
  ok('devices online', { devices: await states(page) });

  // BLE-only recording: uncheck "also save on flash"
  await page.$eval('.rec__check input[type="checkbox"]', (cb) => {
    if (cb.checked) cb.click();
  });
  await page.$eval('#rec-title', (el) => {
    el.value = 'HW E2E (BLE only)';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('[data-testid="start-recording"]');
  await page.waitForSelector('[data-testid="stop-recording"]', { timeout: 30000 });
  await until(page, (s) => s.every((d) => d.stream === 'flowing'), 'all streaming', 90000);
  ok('recording, all streaming');
  await sleep(PHASE_S * 1000);
  const s1 = await page.evaluate(() => window.__mwebRecording.samples);
  ok('phase 1 samples', { samples: s1 });

  await page.evaluate(() => window.__mwebDevices.entries[0].simulateDrop());
  await until(page, (s) => s[0].conn === 'reconnecting', 'reconnecting', 15000);
  ok('link 0 dropped');
  await until(page, (s) => s[0].conn === 'online' && s[0].stream === 'flowing', 'restarted & streaming', 120000);
  ok('reconnected; logging restarted by the recorder');
  await sleep(PHASE_S * 1000);
  const s2 = await page.evaluate(() => window.__mwebRecording.samples);
  ok('phase 2 samples', { samples: s2 });

  await page.click('[data-testid="stop-recording"]');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog[open] button[type="submit"]');
  await until(page, (s) => s.every((d) => d.logging === false), 'devices stopped', 30000);
  ok('stopped');

  await page.goto(URL.replace('#/', '#/data'));
  await page.waitForSelector('[data-testid="download"]');
  const before = new Set(readdirSync(downloads));
  await page.click('[data-testid="download"]');
  let file;
  for (let i = 0; i < 60 && !file; i++) {
    await sleep(500);
    file = readdirSync(downloads).find((f) => !before.has(f) && /\.(zip|csv)$/.test(f));
  }
  if (!file) throw new Error('nothing downloaded');
  const entries = unzipSync(readFileSync(join(downloads, file)));
  const csvs = Object.keys(entries).filter((n) => n.endsWith('.csv'));
  const summary = csvs.map((n) => {
    const lines = strFromU8(entries[n]).split('\r\n').filter(Boolean);
    const ts = lines.slice(1).map((l) => Number(l.split(',')[1]));
    const gaps = ts.slice(1).map((t, i) => t - ts[i]).filter((d) => d > 20);
    return { file: n, rows: lines.length - 1, first: lines[1], last: lines.at(-1), gapsOver20s: gaps };
  });
  ok('export', { file, csvs: summary });
  report.ok = summary.length === used.size && summary.every((c) => c.rows > 10);
  console.log(report.ok ? '✓ PASS' : '✗ FAIL');
} catch (e) {
  report.ok = false;
  report.error = String(e);
  console.error('✗', e);
} finally {
  const dir = join(import.meta.dirname, '..', 'tests', 'hw', 'out');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `hw-recording-${Date.now()}.json`), JSON.stringify(report, null, 2));
  await page?.evaluate(() => window.__mwebDevices?.entries.forEach((e) => e.controller.disconnect())).catch(() => {});
  await browser?.close().catch(() => {});
}
