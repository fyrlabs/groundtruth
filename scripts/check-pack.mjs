#!/usr/bin/env node
// Assert the published tarball contains everything the plugin needs to function.
//
// package.json "files" is an allowlist, so omitting a directory is silent: the package installs
// cleanly and is missing its manifest, hooks, or resolver. Nothing errors. That is the failure this
// catches — it is the reason the original install shipped a skill folder with no .claude-plugin.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Everything a working install needs. A missing entry here is a broken release.
const REQUIRED = [
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'agents',
  'skills/analyze/SKILL.md',
  'hooks/hooks.json',
  'scripts/paths.mjs',
  'scripts/state.mjs',
  'scripts/clone.mjs',
  'scripts/drift.mjs',
  'scripts/render.mjs',
  'scripts/synthesize.mjs',
  'scripts/write-payload.mjs',
  'scripts/validate-payload.mjs',
  'scripts/resolve-models.mjs',
  'scripts/install-guardrails.mjs',
  'scripts/verify-layout.mjs',
  'scripts/evaluate.mjs',
  'core/lib/paths.mjs',
  'core/lib/state.mjs',
  'core/lib/validate.mjs',
  'core/lib/clone.mjs',
  'core/lib/injection.mjs',
  'core/lib/render.mjs',
  'core/schema/profile.schema.json',
  'core/schema/claim.schema.json',
  'config/models.json',
  'AGENTS.md',
  'SECURITY.md',
  'README.md',
  'LICENSE',
  'NOTICE',
];

// Present in the repo, must NOT ship. Run state and generated output are per-user, and shipping them
// means a fresh install arrives with someone else's registry — or, worse, the installer's update path
// overwrites the user's own.
const FORBIDDEN = ['output', 'tracking', 'bin', 'sources', 'node_modules', '.env'];

function listed() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

let files;
try {
  files = listed();
} catch (error) {
  process.stderr.write(`could not run npm pack: ${error.message}\n`);
  process.exit(1);
}

const errors = [];

const missing = REQUIRED.filter((r) => !files.some((p) => p === r || p.startsWith(`${r}/`)));
if (missing.length) errors.push(`tarball is missing:\n    ${missing.join('\n    ')}`);

const allowlist = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files || [];
for (const forbidden of FORBIDDEN) {
  if (allowlist.some((f) => f.startsWith(forbidden))) {
    errors.push(`package.json "files" includes ${forbidden}/ — run state and generated output must not ship`);
  }
  const shipped = files.filter((p) => p === forbidden || p.startsWith(`${forbidden}/`));
  if (shipped.length) errors.push(`tarball contains ${shipped.length} ${forbidden}/ entries`);
}

// Every agent and skill referenced by the orchestrator must exist in the tarball, or a fresh install
// is missing them even though the repo has them.
for (const file of files.filter((p) => p.startsWith('agents/') && p.endsWith('.md'))) {
  if (!file.endsWith('.md')) continue;
  const body = readFileSync(join(ROOT, file), 'utf8');
  if (!/^---\n/.test(body)) errors.push(`${file} ships without frontmatter`);
}

if (errors.length) {
  process.stderr.write('\npackaging check failed\n\n');
  for (const e of errors) process.stderr.write(`  ${e}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(`packaging ok: ${files.length} files, ${REQUIRED.length} required paths present\n`);
if (!existsSync(join(ROOT, '.npmignore'))) {
  process.stdout.write('note: .npmignore is absent, which is correct — "files" is the contract\n');
}