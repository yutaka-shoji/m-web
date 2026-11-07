// End-to-end check of the real app UI against real M-Loggers (development server).
//
// Adds every M-Logger nearby through the actual "Add M-Logger" button (the Web Bluetooth
// chooser is answered through CDP), starts live view on all of them, drops one GATT link to
// exercise automatic reconnection, then stops everything and disconnects. Flash memory is
// never written (live view = BLE-only logging).
//
// Prerequisite: `npm run dev`. Usage: node scripts/hw-e2e.mjs [maxDevices=3]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const MAX = Number(process.argv[2] ?? 3);
const PORT = Number(process.env.CDP_PORT ?? 9334);
const URL = process.env.APP_URL ?? 'http://localhost:5173/#/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = join(import.meta.dirname, '..', 'tests', 'hw', 'out');
mkdirSync(outDir, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'mweb-e2e-'));
execFileSync('open', ['-na', 'Google Chrome', '--args', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1360,900', URL]);

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {
    await sleep(250);
  }
}
if (!browser) throw new Error('Chrome DevTools endpoint not reachable');

const report = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => {
  const entry = { t: new Date().toISOString(), name, ...data };
  report.steps.push(entry);
  console.log(`✓ ${name}`, data ? JSON.stringify(data) : '');
};
const states = (page) =>
  page.evaluate(() =>
    window.__mwebDevices.entries.map((e) => ({
      name: e.state.value.meta.name,
      conn: e.state.value.conn.state,
      logging: e.state.value.logging,
      stream: e.state.value.stream,
      t: e.live.value.values.t.value,
    })),
  );
async function waitFor(page, pred, label, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const s = await states(page);
    if (pred(s)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label} — ${JSON.stringify(s)}`);
    await sleep(500);
  }
}

try {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith(URL.replace(/#.*$/, '')));
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('app page did not open');
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.waitForFunction(() => '__mwebDevices' in window, { timeout: 15000 });

  // 1. add devices through the real button
  const used = new Set();
  for (let i = 0; i < MAX; i++) {
    const selector = i === 0 ? '[data-testid="add-device-empty"]' : '[data-testid="add-device"]';
    await page.waitForSelector(`${selector}:not([disabled])`, { timeout: 30000 });
    const [prompt] = await Promise.all([page.waitForDevicePrompt({ timeout: 30000 }), page.click(selector)]);
    let dev;
    try {
      dev = await prompt.waitForDevice(
        (d) => (d.name?.startsWith('MLogger_') || d.name?.startsWith('XBee3')) && !used.has(d.id),
        { timeout: 20000 },
      );
    } catch {
      await prompt.cancel().catch(() => {});
      break;
    }
    used.add(dev.id);
    await prompt.select(dev);
    await waitFor(page, (s) => s.length === i + 1 && s[i].conn === 'online', `device ${i + 1} online`, 60000);
    step(`device ${i + 1} online`, { chooserName: dev.name });
  }
  const n = used.size;
  if (n === 0) throw new Error('no M-Logger found');
  step('all online', { devices: await states(page) });

  // 2. live view on all (one device alone has no bulk button: use its card)
  if (n > 1) await page.click('[data-testid="live-all"]');
  else await page.evaluate(() => window.__mwebDevices.entries[0].controller.startLive());
  const live = await waitFor(page, (s) => s.every((d) => d.stream === 'flowing' && d.t !== null), 'live values', 90000);
  step('live values on all', { devices: live });
  await page.screenshot({ path: join(outDir, `e2e-live-${Date.now()}.png`) });

  // 3. drop one link and watch it come back
  await page.evaluate(() => window.__mwebDevices.entries[0].simulateDrop());
  await waitFor(page, (s) => s[0].conn === 'reconnecting', 'reconnecting', 10000);
  step('link dropped → reconnecting');
  const back = await waitFor(page, (s) => s[0].conn === 'online', 'reconnected', 60000);
  step('reconnected', { device: back[0] });

  // BLE-only logging ends with the link (firmware behaviour): start it again
  if (!back[0].logging) {
    await page.evaluate(() => window.__mwebDevices.entries[0].controller.startLive());
    await waitFor(page, (s) => s[0].stream === 'flowing', 'live again', 90000);
    step('live view restarted after reconnect');
  }

  // 4. stop all and disconnect
  if (n > 1) await page.click('[data-testid="stop-all"]');
  else await page.evaluate(() => window.__mwebDevices.entries[0].controller.stopLogging());
  await waitFor(page, (s) => s.every((d) => d.logging === false), 'stopped', 20000);
  step('stopped all');
  await page.evaluate(() => window.__mwebDevices.entries.forEach((e) => e.controller.disconnect()));
  step('disconnected all');
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = String(e);
  console.error('✗', e);
} finally {
  const file = join(outDir, `e2e-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`report: ${file}`);
  await browser.close().catch(() => {});
}
