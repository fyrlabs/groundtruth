#!/usr/bin/env node
// Score a profile against a fixture's declared ground truth.
//
// This measures the pipeline's output, not the model's behaviour in the abstract: given a profile the
// pipeline produced, does each known-claim fixture land on the tier it should?
//
// Usage:
//   node scripts/evaluate.mjs --fixture test/fixtures/known-claims-repo
//   node scripts/evaluate.mjs --profile <path/to/profile.json> --key owner.repo
//   node scripts/evaluate.mjs --fixture-dir <dir>   # discover fixtures, report coverage
//
// Exit 0 when every expectation is met, 1 otherwise, so CI can gate on it. A fixture with no
// profile yet is reported as unmeasured rather than passing silently.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../core/lib/validate.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const FIXTURES = {
  'known-claims-repo': {
    repo: 'fixture/known-claims-repo',
    expectations: [
      { match: '3 platforms', want: 'code-verified', why: 'three installers ship in installers/' },
      { match: '4 plugins', want: 'contradicted', why: 'no plugins directory exists' },
      { match: 'MIT licensed', want: 'code-verified', why: 'the LICENSE file is MIT' },
      { match: '10,000', want: 'unverifiable', why: 'no benchmark harness ships, so it cannot be settled either way' },
      { match: 'audited', want: 'contradicted', why: 'AUDIT.md states the audit was not performed' },
    ],
  },
};

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] || null;
};

function scoreExpectations(spec, profile) {
  const rows = [];
  for (const exp of spec.expectations) {
    const claim = profile.claims?.find((c) => new RegExp(exp.match, 'i').test(c.claim));
    if (!claim) {
      rows.push({ ...exp, got: null, ok: false, note: 'no claim matched — extraction missed it' });
      continue;
    }
    rows.push({ ...exp, got: claim.tier, ok: claim.tier === exp.want });
  }
  return rows;
}

function report(name, rows) {
  const passed = rows.filter((r) => r.ok).length;
  process.stdout.write(`\n${name}\n\n`);
  process.stdout.write(`  ${'expectation'.padEnd(18)}${'want'.padEnd(17)}${'got'.padEnd(17)}result\n`);
  for (const r of rows) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    const note = r.ok ? r.why : `${r.note || 'tier mismatch'} — expected because ${r.why}`;
    process.stdout.write(`  ${String(r.match).padEnd(18)}${String(r.want).padEnd(17)}${String(r.got ?? '—').padEnd(17)}${mark}\n`);
    if (!r.ok) process.stdout.write(`      ${note}\n`);
  }
  process.stdout.write(`\n  ${passed}/${rows.length} expectations met\n`);
  return passed === rows.length;
}

const profilePath = flag('profile');
const fixture = flag('fixture');

if (profilePath) {
  const key = flag('key') || profilePath.split('/').pop().replace(/\.json$/, '');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  const spec = FIXTURES[key] || FIXTURES[fixture] || {
    repo: key,
    expectations: [],
  };
  if (!spec.expectations.length) {
    process.stdout.write(`no expectations declared for "${key}" — nothing to score.\n`);
    process.stdout.write(`known fixtures: ${Object.keys(FIXTURES).join(', ')}\n`);
    process.exit(0);
  }
  const validation = validateProfile(profile, { key: profile.repo.key, enforceReads: false });
  if (!validation.ok) {
    process.stderr.write('profile failed validation, so its tiers cannot be trusted:\n');
    for (const e of validation.errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  process.exit(report(spec.repo, scoreExpectations(spec, profile)) ? 0 : 1);
}

const fixtureDir = flag('fixture-dir') || join(ROOT, 'test', 'fixtures');
process.stdout.write('\nfixture coverage\n\n');
const present = existsSync(fixtureDir) ? readdirSync(fixtureDir).filter((d) => existsSync(join(fixtureDir, d))) : [];
for (const [name, spec] of Object.entries(FIXTURES)) {
  const onDisk = present.includes(name);
  const measured = process.env.GROUNDTRUTH_RESULTS?.includes(name);
  process.stdout.write(`  ${name.padEnd(22)}${onDisk ? 'present' : 'MISSING'}${measured ? ', measured' : ', unmeasured'}\n`);
  process.stdout.write(`    ${spec.expectations.length} expectations declared\n`);
}
process.stdout.write('\nNo fixture has been scored against a live model run yet.\n');
process.stdout.write('That is expected for v0.2.0, which is the first version in which the pipeline runs.\n');
process.stdout.write(`Score one: node scripts/evaluate.mjs --profile <profile.json> --key <owner.repo>\n\n`);
