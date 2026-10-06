#!/usr/bin/env node
// Write a reconciled profile. Thin alias over write-payload so the reconciler has one obvious call.
//
// Usage: write-profile.mjs --key <owner.repo> <<<'{...}'
//
// The profile always lands in the state directory, so a resume finds it. An earlier version accepted an
// output path and honoured it, which let a profile be written outside state where nothing could
// recover it — during the first live run, which is how the gap was found.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const keyIdx = args.indexOf('--key');
const key = keyIdx !== -1 ? args[keyIdx + 1] : args[0];

if (!key) {
  process.stderr.write('usage: write-profile.mjs --key <owner.repo> <<<json\n');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, [join(here, 'write-payload.mjs'), 'profile', key], { stdio: 'inherit' });
process.exit(result.status ?? 1);
