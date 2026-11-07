import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const coreDir = join(root, 'src', 'core');

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('architecture', () => {
  // src/core must stay framework-agnostic so it runs (and is tested) in Node and in workers.
  it('src/core does not import Vue, Pinia, the router or app code', () => {
    const forbidden = /from\s+['"](vue|pinia|vue-router|@vue\/[^'"]+|\.\.\/(\.\.\/)*app\/[^'"]*)['"]/;
    const offenders = walk(coreDir)
      .filter((f) => forbidden.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });
});
