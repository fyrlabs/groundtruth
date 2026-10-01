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

// GitHub only for now. Other forges and non-repo targets are rejected loudly rather than
// half-parsed: a mis-parsed URL becomes a wrong sources/ directory and a profile attributed to
// the wrong project, which is worse than a clear error.
export function repoKey(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  if (!m) return null;
  const key = `${m[1].toLowerCase()}.${m[2].toLowerCase()}`.replace(/[^a-z0-9._-]/g, '-');
  return key.includes('.') ? key : null;
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
  for (const dir of ['', 'runs', 'repos', 'output']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return root;
}

// Clones are deliberately NOT under the state root, which defaults to <project>/.claude/groundtruth.
// A repository inside the project tree is project configuration as far as the host harness is
// concerned: it would load the clone's CLAUDE.md, AGENTS.md, and .claude/skills/** as instructions
// the moment an agent read a file there. So clones go to a per-user cache instead.
export function cloneRoot() {
  return process.env.GROUNDTRUTH_CLONE_DIR || join(homedir(), '.cache', 'groundtruth', 'sources');
}

export const paths = {
  pluginRoot: PLUGIN_ROOT,
  stateRoot: stateRoot,
  runsDir: () => join(stateRoot(), 'runs'),
  reposDir: () => join(stateRoot(), 'repos'),
  sourcesDir: cloneRoot,
  outputDir: () => join(stateRoot(), 'output'),
  schemasDir: () => join(CORE_ROOT, 'schema'),
  libDir: () => join(CORE_ROOT, 'lib'),
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