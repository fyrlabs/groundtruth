// Clone hardening. The only sanctioned way to fetch a repo.
//
// Repositories are hostile input. This refuses, before any agent runs:
//   - trees carrying .claude/, CLAUDE.md, AGENTS.md, or GEMINI.md. Not for tidiness: the host
//     harness auto-loads those as instructions the moment an agent Reads a file in the tree, so a
//     hostile repo would otherwise be able to set its own rules (and pre-approve its own tools).
//   - anything over the size or file caps, checked deterministically rather than by asking the
//     model to be careful.
//   - symlinks that resolve outside the clone.
//
// Clones land outside the project tree for the same reason: inside it, the repo is project
// instructions by construction.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync, rmSync, statSync, lstatSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { paths, repoDir, repoKey, stateRoot } from './paths.mjs';

export const CAPS = {
  maxFiles: 40000,
  maxBytes: 512 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxDepth: 12,
};

// Nested instruction and config files. Presence of any of these is disqualifying: the harness
// would load them as instructions, and a repo that ships them is asserting control over its
// reader rather than describing itself.
const CONTROL_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', 'CLAUDE.local.json']);
const CONTROL_DIRS = new Set(['.claude', '.gemini', '.cursor']);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'target', 'dist', 'build', '__pycache__', '.venv', 'venv']);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
}

export function inspectTree(root) {
  const findings = [];
  let files = 0;
  let bytes = 0;

  const walk = (dir, depth) => {
    if (depth > CAPS.maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = resolve(dir, readlinkSync(full));
        } catch {
          findings.push({ kind: 'symlink-unreadable', path: relative(root, full) });
          continue;
        }
        if (target !== root && !target.startsWith(root + sep)) {
          findings.push({ kind: 'symlink-escape', path: relative(root, full) });
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (CONTROL_DIRS.has(entry.name)) {
          findings.push({ kind: 'control-dir', path: relative(root, entry.name) });
          continue;
        }
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (CONTROL_FILES.has(entry.name)) {
        findings.push({ kind: 'control-file', path: relative(root, entry.name) });
        continue;
      }
      files += 1;
      try {
        const size = lstatSync(full).size;
        bytes += size;
        if (size > CAPS.maxFileBytes) findings.push({ kind: 'file-too-large', path: relative(root, full) });
      } catch { /* unreadable file: not itself disqualifying */ }
    }
  };

  walk(root, 0);

  if (files > CAPS.maxFiles) findings.push({ kind: 'too-many-files', path: '.', count: files });
  if (bytes > CAPS.maxBytes) findings.push({ kind: 'tree-too-large', path: '.', count: bytes });
  return { files, bytes, findings };
}

// Shallow, single-branch, no submodules: we analyse the source, not its history or its dependencies.
export function cloneRepo(url, { force = false } = {}) {
  const key = repoKey(url);
  if (!key) return { key: null, ok: false, reason: `not a GitHub repo URL: ${url}` };

  const root = repoDir(key);
  if (existsSync(join(root, '.git'))) {
    const { findings } = inspectTree(root);
    if (!findings.length) return { key, ok: true, root, reused: true, sha: git(['rev-parse', 'HEAD'], root).trim() };
    if (!force) return { key, ok: false, root, reason: 'existing clone contains control files; re-clone with --force', findings };
    rmSync(root, { recursive: true, force: true });
  }

  mkdirSync(root, { recursive: true });
  try {
    git(['clone', '--depth', '1', '--no-tags', '--single-branch', '--no-recurse-submodules', url, root], paths.sourcesDir());
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    return { key, ok: false, reason: `clone failed: ${String(error.stderr || error.message).trim()}` };
  }

  const { files, bytes, findings } = inspectTree(root);
  if (findings.length) {
    // Keep the tree for forensics, but mark it unusable. An agent must never be pointed here.
    rmSync(join(root, '.git'), { recursive: true, force: true });
    return { key, ok: false, root, reason: 'tree contains harness control files or exceeds caps', findings, files, bytes };
  }

  const sha = git(['rev-parse', 'HEAD'], root).trim();
  return { key, ok: true, root, sha, files, bytes, reused: false };
}

// Read-only remote probe. Uses ls-remote rather than `git pull`: pulling mutates the working tree
// under the analyzer's feet and runs on an untrusted repo with the user's real Git identity, which
// is the highest-privilege operation in the pipeline for no analytical benefit.
export function remoteSha(url) {
  const out = git(['ls-remote', '--heads', '--tags', url], paths.sourcesDir());
  const lines = out.trim().split('\n').filter(Boolean);
  const refs = {};
  for (const line of lines) {
    const [sha, ref] = line.split(/\s+/);
    if (sha && ref) refs[ref] = sha;
  }
  return refs;
}

export function logInjection(root, key, detections) {
  if (!detections.length) return;
  const file = join(stateRoot(), 'injections.jsonl');
  mkdirSync(stateRoot(), { recursive: true });
  for (const d of detections) {
    appendFileSync(file, `${JSON.stringify({ repo: key, file: d.file, kind: d.kind, at: new Date().toISOString() })}\n`);
  }
}

export { CONTROL_FILES, CONTROL_DIRS, CAPS as CLONE_CAPS };