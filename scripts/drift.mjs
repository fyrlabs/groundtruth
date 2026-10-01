#!/usr/bin/env node
// Deterministic drift check. No LLM, no `git pull`, no mutation of the working tree.
//
// Compares the recorded commit SHA against the remote. `git ls-remote` is read-only and needs no
// credentials, so it does not run the user's real Git identity against an untrusted remote — which
// is what `git pull` used to do.
//
// Usage: drift.mjs [--json]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateRoot, paths } from '../core/lib/paths.mjs';
import { readJson } from '../core/lib/state.mjs';
import { remoteSha } from '../core/lib/clone.mjs';

ensureStateRoot();

function semverParts(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// The one place a judgment call is allowed, and only once a SHA change is already established.
function classify(record, refs, registry) {
  const known = refs[`refs/heads/${record.ref || 'HEAD'}`];
  const remote = known || refs['refs/heads/main'] || refs['refs/heads/master'] || Object.values(refs)[0];
  if (!remote) return { level: 'UNKNOWN_DRIFT', why: 'remote exposes no refs (empty repo, or network blocked)' };
  if (record.sha && remote.startsWith(record.sha)) return { level: 'NO_DRIFT', why: `sha unchanged (${record.sha.slice(0, 12)})` };

  const before = semverParts(record.version);
  const manifest = registry?.version;
  const after = semverParts(manifest);
  if (before && after && (after[0] !== before[0] || after[1] !== before[1])) {
    return { level: 'SEMANTIC_DRIFT', why: `major/minor version bump ${record.version} -> ${manifest}` };
  }
  const breaking = /\b(BREAKING|breaking change)\b/i.test(record.changelog_tail || '');
  if (breaking) return { level: 'SEMANTIC_DRIFT', why: 'breaking change recorded in changelog since last analysis' };

  return { level: 'CONTENT_DRIFT', why: `sha changed ${(record.sha || '?').slice(0, 12)} -> ${remote.slice(0, 12)}` };
}

const dirs = existsSync(paths.reposDir()) ? readdirSync(paths.reposDir()) : [];
const registry = readJson(join(paths.stateRoot(), 'registry.json'), {});
const rows = [];

for (const key of dirs) {
  const record = readJson(join(paths.reposDir(), key, 'manifest.json'), null);
  const profile = readJson(join(paths.reposDir(), key, 'profile.json'), null);
  if (!profile?.repo?.url || !record?.sha) continue;

  let refs = {};
  let error = null;
  try {
    refs = remoteSha(profile.repo.url);
  } catch (e) {
    error = String(e.stderr || e.message).trim();
  }

  const result = error
    ? { level: 'UNKNOWN_DRIFT', why: `ls-remote failed: ${error}` }
    : classify({ ...record, changelog_tail: record.changelog_tail || '' }, refs, (registry.repos || {})[key]);

  rows.push({ key, url: profile.repo.url, recorded_sha: record.sha, ...result });
}

const asJson = process.argv.includes('--json');
if (asJson) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else if (!rows.length) {
  process.stdout.write('no previously-analysed repos to check\n');
} else {
  for (const r of rows) process.stdout.write(`${r.level.padEnd(15)} ${r.key.padEnd(28)} ${r.why}\n`);
}

// A network blip must never be mistaken for a full re-analysis.
process.exit(rows.some((r) => r.level === 'UNKNOWN_DRIFT') ? 2 : 0);