#!/usr/bin/env node
// Render the markdown report from profile.json state. The only writer of the report.
//
// Usage: render.mjs <owner__repo>...  |  render.mjs --all

import { ensureStateRoot } from '../core/lib/paths.mjs';
import { renderReport } from '../core/lib/render.mjs';

ensureStateRoot();

const args = process.argv.slice(2);
const all = args.includes('--all');
const keys = args.filter((a) => !a.startsWith('--'));

if (!all && !keys.length) {
  process.stderr.write('usage: render.mjs <owner__repo>... | render.mjs --all\n');
  process.exit(2);
}

try {
  const result = renderReport({ keys: all ? null : keys });
  process.stdout.write(`rendered ${result.repos} profile(s) -> ${result.path}\n`);
} catch (error) {
  process.stderr.write(`render failed: ${error.message}\n`);
  process.exit(1);
}