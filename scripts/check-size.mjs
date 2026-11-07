// Fails the build when the JS/CSS needed for the first paint exceeds the budget.
// "Initial" = the entry chunk plus its static imports, as recorded in Vite's manifest.
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET_KB = 150;
const dist = join(import.meta.dirname, '..', 'dist');
const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'));

const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
if (!entryKey) throw new Error('no entry in manifest');

const files = new Set();
const visit = (key) => {
  const chunk = manifest[key];
  if (!chunk || files.has(chunk.file)) return;
  files.add(chunk.file);
  for (const css of chunk.css ?? []) files.add(css);
  for (const imp of chunk.imports ?? []) visit(imp);
};
visit(entryKey);

let total = 0;
const rows = [];
for (const f of files) {
  const buf = readFileSync(join(dist, f));
  const gz = gzipSync(buf, { level: 9 }).length;
  total += gz;
  rows.push([f, (statSync(join(dist, f)).size / 1024).toFixed(1), (gz / 1024).toFixed(1)]);
}
const lazy = Object.values(manifest).filter((c) => c.file.endsWith('.js') && !files.has(c.file));
let lazyGz = 0;
for (const c of lazy) lazyGz += gzipSync(readFileSync(join(dist, c.file)), { level: 9 }).length;

console.log('initial assets (raw KB / gzip KB):');
for (const [f, raw, gz] of rows) console.log(`  ${f.padEnd(48)} ${raw.padStart(8)} ${gz.padStart(8)}`);
console.log(`initial total (gzip): ${(total / 1024).toFixed(1)} KB  (budget ${BUDGET_KB} KB)`);
console.log(`lazy chunks: ${lazy.length}, ${(lazyGz / 1024).toFixed(1)} KB gzip`);

if (total / 1024 > BUDGET_KB) {
  console.error(`✗ initial bundle exceeds ${BUDGET_KB} KB gzip`);
  process.exit(1);
}
