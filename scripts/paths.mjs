#!/usr/bin/env node
// Print the resolved path layout. Callers must not hardcode paths.

import { ensureStateRoot, paths, repoKey } from '../core/lib/paths.mjs';

const root = ensureStateRoot();
const out = {
  plugin_root: paths.pluginRoot,
  state_root: root,
  runs: paths.runsDir(),
  repos: paths.reposDir(),
  sources: paths.sourcesDir(),
  report: `${paths.outputDir()}/groundtruth-report.md`,
};

if (process.argv[2]) {
  const key = repoKey(process.argv[2]);
  out.repo_key = key;
  if (key) out.repo_dir = `${paths.sourcesDir()}/${key}`;
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} else {
  for (const [k, v] of Object.entries(out)) process.stdout.write(`${k.padEnd(12)} ${v}\n`);
}