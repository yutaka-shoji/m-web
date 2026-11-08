// Hardware check: reconnecting a logger after the browser has lost track of it.
//
// Chrome on macOS forgets a device that is not connected and has not advertised for ~3 minutes,
// so a link that drops after being up longer than that cannot be reconnected by gatt.connect()
// ("Bluetooth Device is no longer in range."). This script connects loggers through the real UI,
// keeps live view running past that window, drops one link and checks recovery:
//
//   manual (default): the card shows "Not found"; "Find and reconnect" opens the chooser, the
//                     logger is picked again and comes back online.
//   auto:             Chrome runs with --enable-experimental-web-platform-features, so the app
//                     watches advertisements and reconnects by itself.
//
// Flash memory is never written (live view = BLE-only logging). Prerequisite: `npm run dev`, and
// no other Chrome instance running: macOS then treats this one as a background app and delivers
// no BLE advertisements to it (bluetoothd scan flag FG:0).
// Usage: node scripts/hw-e2e-lost.mjs [manual|auto] [devices=1] [waitSeconds=200] [drop=1]
// (with drop > 1, one chooser pick must bring every dropped logger back)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const MODE = process.argv[2] === 'auto' ? 'auto' : 'manual';
const MAX = Number(process.argv[3] ?? 1);
const WAIT_S = Number(process.argv[4] ?? 200);
const DROP = Number(process.argv[5] ?? 1);
const PORT = Number(process.env.CDP_PORT ?? 9336);
const URL = process.env.APP_URL ?? 'http://localhost:5173/#/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// macOS only delivers BLE scan results to the frontmost app (bluetoothd "FG:1"); with a single
// Chrome running, `open -a` brings this test instance to the front.
const activate = () => execFileSync('open', ['-a', 'Google Chrome']);
const outDir = join(import.meta.dirname, '..', 'tests', 'hw', 'out');
mkdirSync(outDir, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'mweb-lost-'));
const flags = MODE === 'auto' ? ['--enable-experimental-web-platform-features'] : [];
execFileSync('open', ['-na', 'Google Chrome', '--args', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1360,900', ...flags, URL]);

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {
    await sleep(250);
  }
}
if (!browser) throw new Error('Chrome DevTools endpoint not reachable');

const report = { mode: MODE, waitSeconds: WAIT_S, startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => {
  report.steps.push({ t: new Date().toISOString(), name, ...data });
  console.log(`✓ ${name}`, data ? JSON.stringify(data) : '');
};
const states = (page) =>
  page.evaluate(() =>
    window.__mwebDevices.entries.map((e) => ({
      name: e.state.value.meta.name,
      conn: e.state.value.conn.state,
      notInRange: e.state.value.conn.notInRange,
      error: e.state.value.conn.error,
      attempt: e.state.value.conn.attempt,
      logging: e.state.value.logging,
      stream: e.state.value.stream,
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
  report.autoFind = await page.evaluate(() => typeof BluetoothDevice !== 'undefined' && 'watchAdvertisements' in BluetoothDevice.prototype);
  step('page ready', { autoFind: report.autoFind });

  // 1. add loggers through the real button; remember which chooser entry became which card
  const chooserIds = [];
  for (let i = 0; i < MAX; i++) {
    const selector = i === 0 ? '[data-testid="add-device-empty"]' : '[data-testid="add-device"]';
    await page.waitForSelector(`${selector}:not([disabled])`, { timeout: 30000 });
    const [prompt] = await Promise.all([page.waitForDevicePrompt({ timeout: 30000 }), page.click(selector)]);
    let dev;
    try {
      dev = await prompt.waitForDevice(
        (d) => (d.name?.startsWith('MLogger_') || d.name?.startsWith('XBee3')) && !chooserIds.includes(d.id),
        { timeout: 30000 },
      );
    } catch {
      await prompt.cancel().catch(() => {});
      break;
    }
    chooserIds.push(dev.id);
    await prompt.select(dev);
    await waitFor(page, (s) => s.length === i + 1 && s[i].conn === 'online', `device ${i + 1} online`, 60000);
    step(`device ${i + 1} online`, { chooserName: dev.name });
  }
  if (chooserIds.length === 0) throw new Error('no M-Logger found');

  // 2. live view (BLE-only), then stay connected past Chrome's ~3 min device cache window
  await page.evaluate(() => Promise.all(window.__mwebDevices.entries.map((e) => e.controller.startLive())));
  await waitFor(page, (s) => s.every((d) => d.stream === 'flowing'), 'live values', 90000);
  step('live view on all');
  for (let left = WAIT_S; left > 0; left -= 30) {
    console.log(`  … keeping the link up, ${left} s left`);
    await sleep(Math.min(30, left) * 1000);
  }
  step('waited', { seconds: WAIT_S, devices: await states(page) });

  // 3. drop the first link(s)
  const drop = Math.min(DROP, chooserIds.length);
  activate();
  await page.evaluate((n) => window.__mwebDevices.entries.slice(0, n).forEach((e) => e.simulateDrop()), drop);
  step('links dropped', { count: drop });

  if (MODE === 'manual') {
    const lost = await waitFor(page, (s) => s.slice(0, drop).every((d) => d.notInRange), 'not-in-range flag', 20000);
    step('flagged as not found', { error: lost[0].error, conn: lost.slice(0, drop).map((d) => d.conn) });
    await page.screenshot({ path: join(outDir, `lost-card-${Date.now()}.png`) });
    // "Find and reconnect" on the card → chooser → pick the same logger
    await page.waitForSelector('[data-testid="find-device"]', { timeout: 10000 });
    activate();
    const [prompt] = await Promise.all([page.waitForDevicePrompt({ timeout: 30000 }), page.click('[data-testid="find-device"]')]);
    const dev = await prompt.waitForDevice((d) => d.id === chooserIds[0], { timeout: 60000 });
    await prompt.select(dev);
    step('picked again in the chooser', { chooserName: dev.name });
  }

  const t0 = Date.now();
  const back = await waitFor(
    page,
    (s) => s.slice(0, drop).every((d) => d.conn === 'online'),
    'reconnected',
    MODE === 'auto' ? 120000 : 60000,
  );
  step('reconnected', { afterSeconds: Math.round((Date.now() - t0) / 1000), devices: back.slice(0, drop) });

  // BLE-only logging ends with the link (firmware behaviour): start it again, then clean up
  await page.evaluate((n) => Promise.all(window.__mwebDevices.entries.slice(0, n).map((e) => e.controller.startLive())), drop);
  await waitFor(page, (s) => s.slice(0, drop).every((d) => d.stream === 'flowing'), 'live again', 90000);
  step('live view restarted');
  await page.evaluate(() => Promise.allSettled(window.__mwebDevices.entries.map((e) => e.controller.stopLogging())));
  await waitFor(page, (s) => s.every((d) => d.logging === false), 'stopped', 20000);
  await page.evaluate(() => window.__mwebDevices.entries.forEach((e) => e.controller.disconnect()));
  step('stopped and disconnected');
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = String(e);
  console.error('✗', e);
} finally {
  const file = join(outDir, `lost-${MODE}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`report: ${file}`);
  await browser.close().catch(() => {});
}
