// Path resolution. The single source of truth for where groundtruth reads and writes.
//
// The harness passes in plugin root / plugin data via environment; everything else is derived.
// Nothing else in the codebase may hardcode a path.

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// core/lib/paths.mjs -> core/ -> <plugin root>
export const CORE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ? resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : dirname(CORE_ROOT);

const SKILL_DIRS = ['.claude/groundtruth', '.groundtruth'];

// Repo identity is owner__repo. A bare repo name would let acme/tool and other/tool collide.
export function repoKey(url) {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  if (!m) return null;
  return `${m[1].toLowerCase()}.${m[2].toLowerCase()}`.replace(/[^a-z0-9._-]/g, '-');
}

export function repoParts(key) {
  const at = key.indexOf('.');
  return at === -1 ? { owner: '', repo: key } : { owner: key.slice(0, at), repo: key.slice(at + 1) };
}

// State must never be shared between unrelated projects by accident, and must never live inside
// the plugin directory (an update would clobber it).
export function stateRoot() {
  const override = process.env.GROUNDTRUTH_STATE_DIR;
  if (override) return resolve(override);

  if (process.env.CLAUDE_PLUGIN_DATA) return join(resolve(process.env.CLAUDE_PLUGIN_DATA), 'groundtruth');

  const cwd = process.cwd();
  for (const dir of SKILL_DIRS) {
    const candidate = join(cwd, dir);
    if (existsSync(join(candidate, 'state'))) return candidate;
  }
  // Default to the project so per-project research stays separable, which is the whole point.
  return join(cwd, SKILL_DIRS[0]);
}

export function ensureStateRoot() {
  const root = stateRoot();
  for (const dir of ['', 'runs', 'repos', 'sources', 'output']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return root;
}

export const paths = {
  pluginRoot: PLUGIN_ROOT,
  stateRoot: stateRoot,
  runsDir: () => join(stateRoot(), 'runs'),
  reposDir: () => join(stateRoot(), 'repos'),
  sourcesDir: () => join(stateRoot(), 'sources'),
  outputDir: () => join(stateRoot(), 'output'),
  schemasDir: () => join(CORE_ROOT, 'schema'),
  libDir: () => join(CORE_ROOT, 'lib'),
  // Clones live outside the project tree on purpose: a hostile repo inside the project can be
  // auto-loaded as project instructions (CLAUDE.md, .claude/skills/) by the host harness.
  tmpRoot: () => process.env.GROUNDTRUTH_CLONE_DIR || join(homedir(), '.cache', 'groundtruth', 'sources'),
};

export function repoDir(key) {
  return join(paths.sourcesDir(), key);
}

export function repoStateDir(key) {
  return join(paths.reposDir(), key);
}

export function reportPath() {
  return join(paths.outputDir(), 'groundtruth-report.md');
}