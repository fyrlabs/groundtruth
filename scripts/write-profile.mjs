#!/usr/bin/env node
// Write a reconciled profile. Thin alias over write-payload so the reconciler has one obvious call.
//
// Usage: write-profile.mjs <output-path> <<<'{...}'

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [target, keyArg] = process.argv.slice(2);
if (!target) {
  process.stderr.write('usage: write-profile.mjs <output-path> [--key <repo-key>] <<<json\n');
  process.exit(2);
}

const keyFlag = process.argv.indexOf('--key');
const key = keyFlag !== -1 ? process.argv[keyFlag + 1] : keyArg;
const here = dirname(fileURLToPath(import.meta.url));

const result = spawnSync(process.execPath, [join(here, 'write-payload.mjs'), 'profile', key, '--file', target], { stdio: 'inherit' });
process.exit(result.status ?? 1);