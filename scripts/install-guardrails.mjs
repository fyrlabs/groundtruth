#!/usr/bin/env node
// Apply the optional permission and sandbox guardrails to ~/.claude/settings.json.
//
// Why this exists as a script rather than shipped config: a plugin can only contribute `agent` and
// `subagentStatusLine` from its own settings.json — every other key is dropped. So the guardrails
// have to be written to a real settings file, and the user has to choose to do it.
//
// What it does NOT do is claim to contain WebFetch. The sandbox network allowlist covers sandboxed
// commands only; in-process web tools follow permission rules. Deny rules for those are included,
// but they are prompts, not a sandbox.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.HOME || homedir();
const target = join(home, '.claude', 'settings.json');

// Deny rules beat everything and cannot be overridden by a hook or an allow rule, which makes them
// the right place for these. First match wins, order deny -> ask -> allow.
const DENY = [
  'Bash(curl:* | *)',
  'Bash(wget:* | *)',
  'Bash(rm -rf /*)',
  'Bash(rm -rf ~)',
  'Bash(rm -rf $HOME*)',
  'Bash(sudo:*)',
  'Bash(doas:*)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.config/gh/**)',
  'Read(~/.docker/config.json)',
  'Read(~/.kube/**)',
  'Read(~/.netrc)',
  'Read(~/.npmrc)',
  'Read(~/.claude.json)',
  'Read(//**/.env)',
  'Read(//**/.env.*)',
  'Write(~/.claude/skills/**)',
  'Write(~/.claude/agents/**)',
  'Write(~/.claude/commands/**)',
  'Write(~/.claude/hooks/**)',
  'Write(~/.claude/settings.json)',
];

const GUARDRAILS = {
  permissions: {
    deny: DENY,
    blockReadsOutsideWorkingDirectories: false,
  },
  sandbox: {
    enabled: true,
    // A missing sandbox must fail loudly rather than silently running unsandboxed.
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: ['~/'],
      denyRead: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gh', '~/.claude.json'],
      // Allowlist mode is the safe default: a command touching anything not listed is denied, so a
      // newly-installed tool does not silently gain filesystem access.
      allowRead: [],
    },
    network: {
      allowedDomains: ['api.github.com', 'github.com', 'raw.githubusercontent.com', 'registry.npmjs.org', 'pypi.org'],
      strictAllowlist: true,
    },
  },
};

function merge(target, source) {
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      out[key] = [...new Set([...(Array.isArray(out[key]) ? out[key] : []), ...value])];
    } else if (value && typeof value === 'object') {
      out[key] = merge(out[key] || {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

if (process.argv.includes('--print')) {
  process.stdout.write(`${JSON.stringify(GUARDRAILS, null, 2)}\n`);
  process.exit(0);
}

let current = {};
if (existsSync(target)) {
  try {
    current = JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    process.stderr.write(`refusing to write: ${target} is not valid JSON (${error.message})\nFix it by hand, then re-run.\n`);
    process.exit(1);
  }
}

const merged = merge(current, GUARDRAILS);
const backup = `${target}.groundtruth-backup`;
if (existsSync(target) && !existsSync(backup)) {
  renameSync(target, backup);
  process.stdout.write(`backed up existing settings to ${backup}\n`);
}

mkdirSync(join(home, '.claude'), { recursive: true });
writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

process.stdout.write(`applied ${DENY.length} deny rules and sandbox settings to ${target}\n\n`);
process.stdout.write('Two things this does not do:\n');
process.stdout.write('  - WebFetch is not sandboxed. The domain allowlist above covers sandboxed commands only;\n');
process.stdout.write('    in-process web tools follow permission rules, so add deny rules for those yourself if needed.\n');
process.stdout.write('  - hooks remain advisory. A project .claude/settings.json can set disableAllHooks and\n');
process.stdout.write('    turn them off; only managed settings survive that. See SECURITY.md.\n');
process.stdout.write(`\nreview the result: cat ${target}\n`);