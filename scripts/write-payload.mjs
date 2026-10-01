#!/usr/bin/env node
// Write and validate an agent payload. The single write path for pipeline data.
//
// Agents cannot use the Write tool: it cannot create intermediate directories, and granting it to
// nine agents that all read attacker-controlled repositories is the self-escalation hole this
// pipeline exists to close (an injected instruction plus Write would let a repo rewrite an agent's
// own prompt for the next run). They pipe JSON here instead.
//
// Usage: write-payload.mjs <stage> <repo-key> [--file <path>]  <<<'{...}'

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ensureStateRoot, repoStateDir } from '../core/lib/paths.mjs';
import { validateProfile, validateClaimFile } from '../core/lib/validate.mjs';
import { writeJson } from '../core/lib/state.mjs';
import { setRepoStage } from '../core/lib/state.mjs';

ensureStateRoot();

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fileIdx = process.argv.indexOf('--file');
const [stage, key] = args;
const explicitPath = fileIdx !== -1 ? process.argv[fileIdx + 1] : null;

if (!stage || !key) {
  process.stderr.write('usage: write-payload.mjs <stage> <repo-key> [--file <path>]\n');
  process.exit(2);
}

const raw = explicitPath ? readFileSync(explicitPath, 'utf8') : readFileSync(0, 'utf8');

let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  process.stderr.write(`rejected: output is not valid JSON (${error.message})\n\n` +
    'A Markdown block is not an acceptable payload. Output-format forgery — a repository README\n' +
    'containing a block shaped like an agent report — is rejected here by construction, so a repo\n' +
    'cannot forge its own verification verdict.\n');
  process.exit(1);
}

// Structural check first: the shape that makes a payload meaningful for its stage.
const result = stage === 'profile'
  ? validateProfile(payload, { key, enforceReads: false })
  : stage === 'analysis'
    ? validateClaimFile(payload)
    : { ok: true, errors: [] };

if (!result.ok) {
  process.stderr.write(`rejected: ${stage} payload failed validation\n`);
  for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}

const target = explicitPath || `${repoStateDir(key)}/${stage}.json`;
writeJson(target, payload);

if (!explicitPath) {
  setRepoStage(key, stage, 'done');
  process.stderr.write(`ok ${stage} -> ${basename(target)}\n`);
} else {
  process.stderr.write(`ok ${stage} -> ${target}\n`);
}