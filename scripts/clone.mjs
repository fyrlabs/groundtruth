#!/usr/bin/env node
// Shallow, hardened clone. The only sanctioned way to fetch a repo.
//
// Usage: clone.mjs <url>...  [--force] [--json]

import { ensureStateRoot } from '../core/lib/paths.mjs';
import { cloneRepo } from '../core/lib/clone.mjs';
import { setRepoStage, writeJson } from '../core/lib/state.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../core/lib/paths.mjs';

ensureStateRoot();

const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');
// Read the version straight from the manifest rather than asking a model, so drift classification
// never depends on an agent's arithmetic.
function readVersion(root) {
  for (const [file, re] of [
    ['package.json', /"version"\s*:\s*"([^"]+)"/],
    ['pyproject.toml', /^version\s*=\s*"([^"]+)"/m],
    ['Cargo.toml', /^version\s*=\s*"([^"]+)"/m],
    ['setup.py', /version\s*=\s*["']([^"']+)["']/],
  ]) {
    try {
      const m = re.exec(readFileSync(join(root, file), 'utf8'));
      if (m) return m[1];
    } catch { /* not present */ }
  }
  return '';
}

const asJson = process.argv.includes('--json');

if (!urls.length) {
  process.stderr.write('usage: clone.mjs <github-url>... [--force] [--json]\n');
  process.exit(1);
}

const results = urls.map((url) => ({ url, ...cloneRepo(url, { force }) }));
let failed = 0;

for (const r of results) {
  if (r.ok) {
    // Record the SHA at clone time. drift.mjs compares against this, and without a writer for it
    // every repo is skipped — the drift stage would be a permanent no-op while looking like it ran.
    const version = readVersion(r.root);
    const dir = join(paths.reposDir(), r.key);
    // Quarantine is persisted, not just printed. stdout is ephemeral, so a registry entry for a repo
    // that shipped a dozen AGENTS.md files would otherwise contain no record that it did — which
    // inverts the property the registry exists for.
    writeJson(join(dir, 'manifest.json'), {
      sha: r.sha,
      version,
      ref: 'HEAD',
      files: r.files ?? null,
      quarantined: (r.quarantined || []).map((q) => ({ kind: q.kind, path: q.path })),
      cloned_at: new Date().toISOString(),
    });
    setRepoStage(r.key, 'clone', 'done');

    process.stdout.write(`ok        ${r.key}${r.reused ? ' (reused)' : ''} sha=${r.sha?.slice(0, 12)}${version ? ` v${version}` : ''}${r.files ? ` files=${r.files}` : ''}\n`);
    // Quarantine is not a silent convenience: the repo shipped files that instruct an AI reader,
    // and that belongs in the report.
    for (const q of r.quarantined || []) {
      process.stdout.write(`            quarantined ${q.kind}: ${q.path}\n`);
    }
  } else {
    failed += 1;
    // r.url, not `url`: the loop variable was never in scope, so any non-GitHub URL crashed the
    // whole run on a ReferenceError instead of reporting the rejection.
    process.stdout.write(`refused   ${r.key || r.url}: ${r.reason}\n`);
    for (const f of r.findings || []) process.stdout.write(`            - ${f.kind}: ${f.path}${f.quarantinable ? ' (quarantinable)' : ''}\n`);
  }
}

if (asJson) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exit(failed ? 1 : 0);