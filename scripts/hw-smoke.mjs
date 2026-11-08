// Hardware smoke test in real Chrome (P2 go/no-go).
//
// Chrome is started through LaunchServices (`open -na`) with a throwaway profile so that it
// is its own macOS privacy-responsible process (Node children of other tools are killed
// when they touch Bluetooth). Puppeteer then drives /dev/hw-smoke.html and answers the
// Web Bluetooth device chooser through CDP (page.waitForDevicePrompt).
//
// Prerequisite: the Vite dev server is running (npm run dev, default http://localhost:5173).
// Usage: node scripts/hw-smoke.mjs [maxDevices=3]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

// Modes: `smoke` (default; read-only on every device) or `live` (one device: set_time,
// 30 s BLE-only live logging — flash untouched — then a read-only flash download).
const MODE = process.argv[2] === 'live' ? 'live' : 'smoke';
const MAX_DEVICES = MODE === 'live' ? 1 : Number(process.argv[2] ?? 3);
const PORT = Number(process.env.CDP_PORT ?? 9333);
const URL = process.env.SMOKE_URL ?? 'http://localhost:5173/dev/hw-smoke.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'mweb-chrome-'));
execFileSync('open', [
  '-na',
  'Google Chrome',
  '--args',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  URL,
]);

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {
    await sleep(250);
  }
}
if (!browser) throw new Error('could not reach Chrome DevTools endpoint');

const report = { startedAt: new Date().toISOString(), url: URL, devices: [] };
try {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith(URL));
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('smoke page did not open');
  page.on('console', (m) => console.log(`  [page] ${m.text()}`));
  await page.waitForFunction(() => 'mweb' in window || '__mweb' in window, { timeout: 15000 });

  if (process.argv[2] === 'scan' || process.argv[2] === 'scansvc') {
    // Diagnostics: list everything the chooser sees for 15 s (unfiltered, or by XBee service UUID).
    const button = process.argv[2] === 'scan' ? '#scanall' : '#scansvc';
    const [prompt] = await Promise.all([page.waitForDevicePrompt({ timeout: 30000 }), page.click(button)]);
    await sleep(15000);
    report.scan = prompt.devices.map((d) => ({ name: d.name, id: d.id }));
    console.log('chooser saw:', JSON.stringify(report.scan));
    await prompt.cancel().catch(() => {});
    process.exitCode = 0;
  }

  const used = new Set();
  const scanning = process.argv[2] === 'scan' || process.argv[2] === 'scansvc';
  for (let i = 0; i < (scanning ? 0 : MAX_DEVICES); i++) {
    const [prompt] = await Promise.all([page.waitForDevicePrompt({ timeout: 30000 }), page.click('#add')]);
    let device;
    try {
      // macOS may show already-seen units by their cached GAP name "XBee3 Zigbee": track ids.
      device = await prompt.waitForDevice(
        (d) => (d.name?.startsWith('MLogger_') || d.name?.startsWith('XBee3')) && !used.has(d.id),
        { timeout: 20000 },
      );
    } catch {
      const seen = prompt.devices.map((d) => d.name || `(unnamed ${d.id.slice(0, 6)})`);
      console.log(`no further M-Logger found after ${used.size} device(s); chooser saw: ${JSON.stringify(seen)}`);
      await prompt.cancel().catch(() => {});
      await page.waitForFunction((n) => window.__mweb.results.length >= n, { timeout: 10000 }, i + 1).catch(() => {});
      break;
    }
    used.add(device.id);
    console.log(`selecting ${device.name} (${device.id})`);
    await prompt.select(device);
    await page.waitForFunction((n) => window.__mweb.results.length >= n, { timeout: 120000 }, i + 1);
  }
  report.devices = await page.evaluate(() => window.__mweb.results);
  const connected = await page.evaluate(() => window.__mweb.sessions.length);
  if (MODE === 'live') {
    if (connected > 0) report.live = await page.evaluate(() => window.__mweb.liveAndDump(0, 30));
  } else {
    if (connected > 1) report.concurrent = await page.evaluate(() => window.__mweb.concurrentHello());
    if (connected > 0) report.writeChunk = await page.evaluate(() => window.__mweb.chunkTest(0));
  }
  await page.evaluate(() => window.__mweb.closeAll());
} finally {
  const dir = join(import.meta.dirname, '..', 'tests', 'hw', 'out');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `smoke-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`report written: ${file}`);
  await browser.close().catch(() => {});
}
