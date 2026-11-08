// Responsiveness check with demo loggers (no Bluetooth needed).
// 8 demo loggers, each preloaded with 24 h of 1 Hz samples, live data flowing; then cycles the
// chart ranges, hovers across a chart, and changes clo/met (full derived recompute). Reports
// long tasks (> 50 ms) and the worst frame interval per phase, measured inside a visible Chrome.
//
// Prerequisite: `npm run dev`. Usage: node scripts/perf-demo.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = Number(process.env.CDP_PORT ?? 9335);
const URL = process.env.APP_URL ?? 'http://localhost:5173/#/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'mweb-perf-'));
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
if (!browser) throw new Error('Chrome DevTools endpoint not reachable');

const report = { startedAt: new Date().toISOString(), phases: [] };
try {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith(URL.replace(/#.*$/, '')));
    if (!page) await sleep(250);
  }
  await page.bringToFront();
  await page.waitForFunction(() => '__mwebDevices' in window, { timeout: 15000 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  report.setup = await page.evaluate(async () => {
    const store = window.__mwebDevices;
    await store.addDemoDevices(8);
    const t0 = Date.now();
    while (store.entries.some((e) => e.state.value.conn.state !== 'online') && Date.now() - t0 < 40000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const now = Math.floor(Date.now() / 1000) - 5;
    const N = 86400;
    const tFill = performance.now();
    store.entries.forEach((e, d) => {
      const s = e.controller.series;
      s.clear();
      for (let i = 0; i < N; i++) {
        const ph = i / 3600 + d;
        s.append(now - N + i, {
          t: 24 + Math.sin(ph) + d * 0.3, h: 45 + 5 * Math.cos(ph / 2), g: 25 + Math.sin(ph),
          v: 0.1 + 0.05 * Math.sin(ph * 3), vv: 600, l: 500 + 100 * Math.sin(ph), c: 600 + 200 * Math.sin(ph / 3),
        });
      }
    });
    const fillMs = performance.now() - tFill;
    await Promise.allSettled(store.entries.map((e) => e.controller.startLive()));
    // installs the in-page probes
    window.__perf = { long: [], frames: [] };
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__perf.long.push(e.duration))).observe({ type: 'longtask' });
    let last = performance.now();
    const tick = (t) => { window.__perf.frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return { devices: store.entries.length, samplesPerDevice: store.entries[0].controller.series.length, fillMs: Math.round(fillMs) };
  });
  console.log('setup', report.setup);

  const phase = async (name, fn, ms = 5000) => {
    await page.evaluate(() => { window.__perf.long = []; window.__perf.frames = []; });
    await fn();
    await sleep(ms);
    const r = await page.evaluate(() => {
      const f = window.__perf.frames.slice(2);
      const sorted = [...f].sort((a, b) => a - b);
      return {
        longTasks: window.__perf.long.map((d) => Math.round(d)),
        frames: f.length,
        worstFrameMs: Math.round(sorted.at(-1) ?? 0),
        p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      };
    });
    report.phases.push({ name, ...r });
    console.log(name.padEnd(28), JSON.stringify(r));
  };
  const clickRange = async (key) => {
    await page.$eval(`[data-range="${key}"]`, (b) => b.click());
    await sleep(50);
    const active = await page.$eval(`[data-range="${key}"]`, (b) => b.classList.contains('is-active'));
    if (!active) throw new Error(`range ${key} did not activate`);
  };

  await page.evaluate(() => document.querySelector('.stack')?.scrollIntoView());
  await sleep(1500);
  await phase('idle, live 10 min window', async () => {});
  await phase('range 1 h', () => clickRange('h1'));
  await phase('range 6 h', () => clickRange('h6'));
  await phase('range 24 h (8 × 86 400 pts)', () => clickRange('h24'));
  await phase('range all', () => clickRange('all'));
  await phase('hover sweep across a chart', async () => {
    const box = await page.evaluate(() => {
      const r = document.querySelector('.u-over').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    for (let i = 0; i <= 60; i++) {
      await page.mouse.move(box.x + (box.w * i) / 60, box.y + box.h / 2);
      await sleep(40);
    }
  }, 1000);
  await phase('clo/met change (recompute)', () =>
    page.evaluate(() => {
      const input = document.querySelector('#clo');
      input.value = '0.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }),
  );
  report.ok = report.phases.every((p) => p.longTasks.every((d) => d <= 50));
  console.log(report.ok ? '✓ no long task over 50 ms' : '✗ long tasks over 50 ms present');
} catch (e) {
  report.error = String(e);
  console.error(e);
} finally {
  const dir = join(import.meta.dirname, '..', 'tests', 'hw', 'out');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `perf-${Date.now()}.json`), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
}
