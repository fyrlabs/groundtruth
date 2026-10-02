#!/usr/bin/env node
// Validate an agent payload against its schema, plus provenance and anti-forgery rules.
//
// Usage: validate-payload.mjs <file.json> [--key <owner.repo>]
//
// Runtime gate, not a CI check: nothing downstream may read an unvalidated payload.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { ensureStateRoot, repoKey } from '../core/lib/paths.mjs';
import { validateProfile, validateClaimFile } from '../core/lib/validate.mjs';

ensureStateRoot();

const args = process.argv.slice(2);
const file = args[0];
const keyIdx = args.indexOf('--key');
const key = keyIdx !== -1 ? args[keyIdx + 1] : repoKey(args.find((a) => a.startsWith('https://')) || '') || process.env.GROUNDTRUTH_REPO_KEY;

if (!file || !existsSync(file)) {
  process.stderr.write('usage: validate-payload.mjs <file.json> [--key <owner.repo>]\n');
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  process.stderr.write(`FAIL not valid JSON: ${e.message}\n\nA Markdown block is not an acceptable payload — ` +
    'output-format forgery (a repo README containing a block shaped like an agent report) is rejected here by construction.\n');
  process.exit(1);
}

const stage = basename(file, '.json');
const isProfile = stage === 'profile';
const isClaims = stage === 'analysis';

const result = isProfile
  ? validateProfile(payload, { key })
  : isClaims
    ? validateClaimFile(payload)
    : { ok: true, errors: [] };

if (result.ok) {
  process.stderr.write(`ok ${stage}${isProfile ? ` (${result.computed.claims_total} claims, ${result.computed.uncovered} uncovered)` : ''}\n`);
  process.exit(0);
}

process.stderr.write(`FAIL ${stage}\n`);
for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
process.exit(1);