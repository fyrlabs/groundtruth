#!/usr/bin/env node
// Shallow, hardened clone. The only sanctioned way to fetch a repo.
//
// Usage: clone.mjs <url>...  [--force] [--json]

import { ensureStateRoot } from '../core/lib/paths.mjs';
import { cloneRepo } from '../core/lib/clone.mjs';

ensureStateRoot();

const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');
const asJson = process.argv.includes('--json');

if (!urls.length) {
  process.stderr.write('usage: clone.mjs <github-url>... [--force] [--json]\n');
  process.exit(1);
}

const results = urls.map((url) => cloneRepo(url, { force }));
let failed = 0;

for (const r of results) {
  if (r.ok) {
    process.stdout.write(`ok        ${r.key}${r.reused ? ' (reused)' : ''} sha=${r.sha?.slice(0, 12)}${r.files ? ` files=${r.files}` : ''}\n`);
  } else {
    failed += 1;
    process.stdout.write(`refused   ${r.key || url}: ${r.reason}\n`);
    for (const f of r.findings || []) process.stdout.write(`            - ${f.kind}: ${f.path}\n`);
  }
}

if (asJson) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exit(failed ? 1 : 0);