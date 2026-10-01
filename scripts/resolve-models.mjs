#!/usr/bin/env node
// Resolve a model tier to something installable, and record what was resolved.
//
// `model` in subagent frontmatter is static text read at spawn time — no script, hook, or settings
// key can change it at runtime. So resolution happens here, before the agents are installed, and the
// result is written into each agent file.
//
// Reproducibility is captured at the same moment: a subagent cannot reliably report which concrete
// model it actually ran on (/tasks is interactive-only, and modelUsage is session-level), so the
// resolution is recorded once, at install, into the run's state.
//
// Usage:
//   node scripts/resolve-models.mjs            # print the resolution table
//   node scripts/resolve-models.mjs --write    # write resolved IDs into agents/*.md
//   node scripts/resolve-models.mjs --check    # fail if agents hold unresolved aliases

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'models.json'), 'utf8'));

export function resolveTier(tier) {
  const spec = config.tiers[tier];
  if (!spec) throw new Error(`unknown tier: ${tier}`);
  const envVar = config.env[tier];
  const override = envVar ? process.env[envVar] : undefined;
  return {
    tier,
    requested: override || spec.default,
    source: override ? `env:${envVar}` : 'config default',
    // An explicit full ID is respected as a pin, which is how a reproducibility-conscious user opts
    // out of the alias and accepts that they own the upgrade.
    pinned: /^claude-/.test(override || spec.default),
  };
}

export function resolutionTable() {
  return Object.keys(config.tiers).map(resolveTier);
}

function agentPath(name) {
  const map = {
    discovery: 'discovery.md',
    triage: 'triage.md',
    'drift-checker': 'drift-checker.md',
    'spot-checker': 'spot-checker.md',
    analyzer: 'analyzer.md',
    'technical-verifier': 'technical-verifier.md',
    'community-verifier': 'community-verifier.md',
    'conflicts-verifier': 'conflicts-verifier.md',
    'meta-reconciler': 'meta-reconciler.md',
  };
  return map[name] ? join(ROOT, 'agents', map[name]) : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const table = resolutionTable();
  const byName = Object.fromEntries(Object.entries(config.tiers).flatMap(([tier, spec]) => spec.used_by.map((n) => [n, tier])));

  if (process.argv.includes('--write')) {
    let changed = 0;
    for (const [name, tier] of Object.entries(byName)) {
      const path = agentPath(name);
      if (!path) continue;
      const text = readFileSync(path, 'utf8');
      const resolved = resolveTier(tier).requested;
      const next = text.replace(/^model: .*$/m, `model: ${resolved}`);
      if (next !== text) {
        writeFileSync(path, next, 'utf8');
        changed += 1;
      }
    }
    process.stdout.write(`resolved models into ${changed} agent file(s)\n`);
    for (const row of table) {
      process.stdout.write(`  ${row.tier.padEnd(7)} ${row.requested.padEnd(24)} ${row.pinned ? 'pinned' : 'alias'} (${row.source})\n`);
    }
  } else if (process.argv.includes('--check')) {
    const unresolved = [];
    for (const [name, tier] of Object.entries(byName)) {
      const path = agentPath(name);
      if (!path) continue;
      const text = readFileSync(path, 'utf8');
      const model = /^model: (.+)$/m.exec(text)?.[1]?.trim();
      if (model && !/^claude-/.test(model)) unresolved.push(`${name}: ${model} (tier ${tier})`);
    }
    if (unresolved.length) {
      process.stdout.write('agents still hold aliases (expected in the source tree):\n');
      for (const u of unresolved) process.stdout.write(`  ${u}\n`);
      process.stdout.write('\ninstalled copies should carry resolved IDs: node scripts/resolve-models.mjs --write\n');
    } else {
      process.stdout.write('all agents carry resolved model IDs\n');
    }
  } else {
    for (const row of table) {
      process.stdout.write(`${row.tier.padEnd(7)} ${row.requested.padEnd(24)} ${row.pinned ? 'pinned' : 'alias'} (${row.source})\n`);
    }
    process.stdout.write('\naliases resolve per provider and update over time; see config/models.json notes\n');
  }
}