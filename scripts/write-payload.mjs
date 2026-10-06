#!/usr/bin/env node
// Write and validate an agent payload. The single write path for pipeline data.
//
// Agents cannot use the Write tool: it cannot create intermediate directories, and granting it to
// nine agents that all read attacker-controlled repositories is the self-escalation hole this
// pipeline exists to close (an injected instruction plus Write would let a repo rewrite an agent's
// own prompt for the next run). They pipe JSON here instead.
//
// Usage: write-payload.mjs <stage> <repo-key> [--file <path>]  <<<'{...}'
//
// --file is *input*: it names a file to read the payload from. The payload is still written to the
// state directory, so a stage written with --file is indistinguishable from one written from stdin
// and is recovered by a resume like any other. An earlier revision treated --file as the output path
// too, which silently wrote a profile outside state where nothing could find it — the exact
// success-marker-over-a-total-miss failure this pipeline exists to prevent, reproduced in its own
// tooling during the first live run.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ensureStateRoot, repoStateDir } from '../core/lib/paths.mjs';
import { validateProfile, validateClaimFile, validateVerdictFile } from '../core/lib/validate.mjs';
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

// Every stage is validated. A stage that fell through to "ok" was a stage whose payload shape was
// never checked, so six of the seven non-profile stages accepted anything at all.
const VALIDATED_STAGES = new Set(['analysis', 'technical', 'community', 'conflicts', 'spotcheck', 'drift', 'profile']);

if (!VALIDATED_STAGES.has(stage)) {
  process.stderr.write(`unknown stage: ${stage}. Known: ${[...VALIDATED_STAGES].join(', ')}\n`);
  process.exit(2);
}

// enforceReads on: the write is the moment the read log still corresponds to this run.
const result = stage === 'profile'
  ? validateProfile(payload, { key, enforceReads: true })
  : stage === 'analysis'
    ? validateClaimFile(payload)
    : validateVerdictFile(payload, { stage });

if (!result.ok) {
  process.stderr.write(`rejected: ${stage} payload failed validation\n`);
  for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}

// Always into state, regardless of where the payload was read from.
const target = `${repoStateDir(key)}/${stage}.json`;
writeJson(target, payload);
setRepoStage(key, stage, 'done');
process.stderr.write(`ok ${stage} -> ${basename(target)}\n`);
