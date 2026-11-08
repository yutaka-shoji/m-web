// Screenshots for visual review (demo loggers, light + dark). Prerequisite: `npm run dev`.
// Usage: node scripts/screens.mjs [outDir=tests/hw/out/screens]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = Number(process.env.CDP_PORT ?? 9340);
const BASE = process.env.APP_URL ?? 'http://localhost:5173/';
const out = process.argv[2] ?? join(import.meta.dirname, '..', 'tests', 'hw', 'out', 'screens');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'mweb-screens-'));
execFileSync('open', ['-na', 'Google Chrome', '--args', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000', `${BASE}#/`]);
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {
    await sleep(250);
  }
}
try {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith(BASE));
    if (!page) await sleep(250);
  }
  await page.bringToFront();
  await page.evaluate(() => localStorage.setItem('m-web.locale', 'ja'));
  await page.reload();
  await page.waitForSelector('[data-testid="add-demo-empty"]');
  await page.screenshot({ path: join(out, '01-empty.png') });
  await page.click('[data-testid="add-demo-empty"]');
  await page.waitForFunction(() => window.__mwebDevices.entries.length === 3 && window.__mwebDevices.entries.every((e) => e.state.value.conn.state === 'online'), { timeout: 30000 });
  await page.evaluate(() => Promise.all(window.__mwebDevices.entries.map((e) => e.controller.startLive())));
  await sleep(45000);
  await page.screenshot({ path: join(out, '02-dashboard-light.png') });
  await page.evaluate(() => document.querySelector('.stack')?.scrollIntoView());
  await sleep(1200);
  await page.screenshot({ path: join(out, '03-charts-light.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.evaluate(() => (window.__mwebDevices.$pinia ? 0 : 0));
  await page.evaluate(() => localStorage.setItem('m-web.theme', 'dark'));
  await page.evaluate(() => window.scrollTo(0, 0));
  // let the settings store pick up the theme so charts re-read their colours
  await page.goto(`${BASE}#/settings`);
  await page.evaluate(() => [...document.querySelectorAll('input[name="theme"]')].find((r) => r.value === 'dark')?.click());
  await sleep(600);
  await page.screenshot({ path: join(out, '04-settings-dark.png') });
  await page.goto(`${BASE}#/`);
  await sleep(2500);
  await page.screenshot({ path: join(out, '05-dashboard-dark.png') });
  await page.evaluate(() => document.querySelector('.stack')?.scrollIntoView());
  await sleep(1500);
  await page.screenshot({ path: join(out, '06-charts-dark.png') });
  await page.goto(`${BASE}#/settings`);
  await page.evaluate(() => [...document.querySelectorAll('input[name="theme"]')].find((r) => r.value === 'light')?.click());
  await page.goto(`${BASE}#/guide`);
  await sleep(1500);
  await page.screenshot({ path: join(out, '07-guide.png') });
  await page.goto(`${BASE}#/guide/csv-の列`);
  await sleep(1200);
  await page.screenshot({ path: join(out, '08-guide-csv.png') });
  console.log(`screens saved to ${out}`);
} finally {
  await browser?.close().catch(() => {});
}
