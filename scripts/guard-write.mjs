#!/usr/bin/env node
// PreToolUse guard for Write / Edit.
//
// Closes the self-escalation path. An agent that can rewrite skills/, agents/, settings.json, or a
// hook rewrites the pipeline's own rules and does not need to inject anything on the next run. It
// also keeps agents out of the generated report: the report is rendered from state, so a hand edit
// is silently discarded by the next render, which is worse than a refused write.

import { join, resolve, sep } from 'node:path';
import { PLUGIN_ROOT } from './hook-lib.mjs';
import { allow, cloneRoot, deny, logEvent, readStdin, stateRoot, toolInputPath } from './hook-lib.mjs';
import { canonical, contains, relativeTo } from './hook-paths.mjs';

const { tool_input: input = {} } = await readStdin();
const target = String(toolInputPath(input) || '');
if (!target) allow();

const absolute = canonical(target.startsWith('/') ? resolve(target) : resolve(process.cwd(), target));
const inPath = (root, p) => contains(root, p);
const home = process.env.HOME || '';

const PROTECTED = [
  // Groundtruth's own installed copy. An agent that rewrites the guards, the agents, or the schema
  // is editing the machinery that constrains it — and the next run inherits the edit silently.
  { root: join(PLUGIN_ROOT, 'hooks'), what: "groundtruth's hooks" },
  { root: join(PLUGIN_ROOT, 'agents'), what: "groundtruth's subagent definitions" },
  { root: join(PLUGIN_ROOT, 'scripts'), what: "groundtruth's guard scripts" },
  { root: join(PLUGIN_ROOT, 'core'), what: "groundtruth's validator and renderer" },
  { root: join(home, '.claude', 'skills'), what: 'skills' },
  { root: join(home, '.claude', 'agents'), what: 'subagent definitions' },
  { root: join(home, '.claude', 'commands'), what: 'slash commands' },
  { root: join(home, '.claude', 'hooks'), what: 'hooks' },
  { root: join(home, '.claude', 'settings.json'), what: 'settings' },
  { root: join(home, '.claude.json'), what: 'global configuration' },
];

for (const { root, what } of PROTECTED) {
  const full = root.endsWith('.json') ? root : join(root, '');
  if (absolute === full.replace(/\/$/, '') || inPath(full, absolute)) {
    logEvent('write-denied-protected', { path: absolute });
    deny(`Blocked: this would modify ${what}. An agent able to rewrite skills, agents, commands, ` +
      'hooks, or settings can change what the next run believes it is doing — no prompt injection ' +
      'required. This is the single most valuable write in an attack and Groundtruth refuses it.');
  }
}

const state = stateRoot();
const rel = contains(state, absolute) ? relativeTo(state, absolute).split(sep)[0] : null;
if (rel === 'output') {
  logEvent('write-denied-output', { path: absolute });
  deny('Blocked: the report is generated. Edit the repo\'s profile.json in the state directory and run ' +
    'scripts/render.mjs — a hand edit to the report is discarded by the next render, which would ' +
    'silently lose it.');
}

const clone = cloneRoot();
if (inPath(clone, absolute)) {
  logEvent('write-denied-clone', { path: absolute });
  deny('Blocked: clones are read-only. Mutating a clone mid-run means two agents can read different ' +
    'bytes of the same file, and the profile would claim a commit that was never analysed. ' +
    'Re-clone with scripts/clone.mjs for a fresh tree.');
}

allow();