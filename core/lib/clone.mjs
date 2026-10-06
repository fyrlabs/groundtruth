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
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { paths, repoDir, repoKey, stateRoot } from './paths.mjs';

export const CAPS = {
  maxFiles: 40000,
  maxBytes: 512 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxDepth: 12,
};

// Nested instruction and config files. These are quarantined, not treated as disqualifying.
//
// The original policy refused any repo shipping one of these. That was correct when clones sat inside
// the project tree, because the host auto-loads a CLAUDE.md from any directory an agent reads in.
// Clones now live in a per-user cache outside every project, so that auto-load cannot happen — and the
// refusal turned out to block most of the ecosystem worth analysing: hermes-agent ships seven
// AGENTS.md files, cloudflare/security-audit-skill ships its own. Refusing them would have made the
// tool useless on exactly the repos people want to check.
//
// So they are moved into a quarantine store outside the clone. The repo stays analysable, and no
// instruction file remains reachable by an agent.
const CONTROL_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', 'CLAUDE.local.json']);
const CONTROL_DIRS = new Set(['.claude', '.gemini', '.cursor']);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'target', 'dist', 'build', '__pycache__', '.venv', 'venv']);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
}

// collect() separates the two outcomes that were previously conflated in one `findings` array:
// things that make a tree dangerous to read (injection surfaces) and things that merely make it
// expensive (size). Quarantine the first, refuse the second.
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
          continue;
        }
        // A symlink named CLAUDE.md or AGENTS.md is the same instruction surface whatever it points
        // at, and skipping it left the name in the clone with no finding at all.
        const leaf = entry.name;
        if (CONTROL_FILES.has(leaf) || CONTROL_DIRS.has(leaf)) {
          findings.push({ kind: 'control-symlink', path: relative(root, full), quarantinable: true });
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (CONTROL_DIRS.has(entry.name)) {
          // Quarantinable like the files. .claude/skills/**/SKILL.md and .claude/agents/*.md are the
        // highest-value injection targets there, so refusing the whole repository over them would
        // exclude the very repos most worth checking while quarantining the harmless names.
        findings.push({ kind: 'control-dir', path: relative(root, full), quarantinable: true });
          continue;
        }
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (CONTROL_FILES.has(entry.name)) {
        findings.push({ kind: 'control-file', path: relative(root, full), quarantinable: true });
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
// Beside the clone root, NOT under the state root. The state root defaults to
// <project>/.claude/groundtruth, which is inside the working directory — and the harness loads
// CLAUDE.md from subdirectories under the cwd once an agent reads a file there. Putting quarantined
// CLAUDE.md there would have reinstated the exact auto-load path that moving clones out of the project
// tree exists to close, one function away. The earlier revision did exactly that.
export function quarantineRoot(key) {
  return join(dirname(paths.sourcesDir()), 'quarantine', key);
}

// A refusal marker must not live inside the clone either: the remote controls that directory, so a
// repo shipping its own .groundtruth-refused.json could refuse its own re-analysis and choose the
// message printed to the user.
export function refusalMarkerPath(key) {
  return join(paths.stateRoot(), 'refusals', `${key}.json`);
}

// Move control files out of the clone rather than deleting them: the repo's own documentation is
// evidence, and a report should be able to say what the project told its AI tools to do.
export function quarantineControls(root, key, findings) {
  const targets = findings.filter((f) => f.quarantinable);
  if (!targets.length) return [];

  const store = quarantineRoot(key);
  try {
    rmSync(store, { recursive: true, force: true });
  } catch (error) {
    // Previously this threw straight out of cloneRepo, killing the clone script and leaving an
    // un-quarantined tree on disk. Failing open on a security control is worse than failing the run.
    return [{ kind: 'quarantine-store-unwritable', path: store, quarantine_failed: String(error.message) }];
  }
  const moved = [];

  for (const f of targets) {
    const from = join(root, f.path);
    const to = join(store, f.path);
    try {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      moved.push({ ...f, quarantined_to: to });
    } catch (error) {
      // rename fails across devices; copy-then-remove is the fallback, and a genuine failure must
      // not be swallowed — an instruction file left in place is the whole risk.
      try {
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
        moved.push({ ...f, quarantined_to: to });
      } catch (inner) {
        // Report everything, including the entries already moved: under-reporting a partial
        // quarantine makes the run log claim less than actually happened.
        moved.push({ ...f, quarantine_failed: String(inner.message) });
        return moved;
      }
      void error;
    }
  }
  return moved;
}

// How many control files the manifest says quarantine removed. Without a manifest nothing was
// quarantined, so the allowance is zero rather than unknown — an unknown allowance would let a
// damaged tree hide behind a missing record.
function manifestQuarantineCount(key) {
  try {
    const raw = readFileSync(join(paths.reposDir(), key, 'manifest.json'), 'utf8');
    return JSON.parse(raw).quarantined?.length ?? 0;
  } catch {
    return 0;
  }
}

// Tracked files that git knows about and the working tree does not have, less the ones quarantine
// deliberately removed. An interrupted `git clone` leaves .git and a resolvable HEAD while most of
// the checkout is absent: reuse accepted that, a live run analysed a one-file fragment of a
// twenty-two-file repository, and the pipeline reported success. `ls-files --deleted` is the only
// plumbing-only way to tell an intact checkout from a partial one.
export function missingTrackedFiles(root, quarantined = 0) {
  let deleted;
  try {
    deleted = git(['ls-files', '--deleted'], root).split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
  return Math.max(0, deleted - quarantined);
}

export function cloneRepo(url, { force = false } = {}) {
  const key = repoKey(url);
  if (!key) return { key: null, ok: false, reason: `not a GitHub repo URL: ${url}` };

  const root = repoDir(key);

  // A refusal marker survives a failed attempt, so a retry reports the real reason instead of
  // letting git fail on a non-empty destination directory and hiding the cause.
  const markerPath = refusalMarkerPath(key);
  if (!force && existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      return { key, ok: false, root, reason: marker.reason, findings: marker.findings || [], repeated: true };
    } catch {
      // An unreadable marker is treated as absent rather than fatal. It used to throw, so a stray
      // file of the same name crashed the clone stage on every revisit.
    }
  }

  // Clean up whenever either signal is present, and let --force decide. Keying cleanup off .git alone
  // made --force unable to recover from a caps refusal, which is the one case that writes a marker.
  if (force && (existsSync(markerPath) || existsSync(join(root, '.git')))) {
    rmSync(root, { recursive: true, force: true });
    rmSync(markerPath, { force: true });
  }

  // Reuse an existing clean clone. Without this, every second call fell through to `git clone` into a
  // non-empty directory, git refused, and the catch below deleted the clone — so re-visiting a repo
  // destroyed it. Revisit is the core product loop (a drift-gated registry), so this regressed on
  // every re-run.
  if (!force && existsSync(join(root, '.git'))) {
    const { findings } = inspectTree(root);
    if (!findings.length) {
      try {
        const sha = git(['rev-parse', 'HEAD'], root).trim();
        // A resolvable HEAD is not evidence of an intact working tree.
        const quarantined = manifestQuarantineCount(key);
        const missing = missingTrackedFiles(root, quarantined);
        if (missing > 0) {
          process.stderr.write(`re-clone     ${key} sha=${sha.slice(0, 12)} ${missing} tracked file(s) missing from the working tree\n`);
          rmSync(root, { recursive: true, force: true });
        } else {
          return { key, ok: true, root, sha, reused: true, files: undefined, bytes: undefined, quarantined: [] };
        }
      } catch {
        rmSync(root, { recursive: true, force: true });
      }
    } else {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Anything already sitting at the target that is not a usable clone is debris: git clone refuses a
  // non-empty destination, so leaving it in place turns a recoverable state into a permanent refusal.
  // Found live after an interrupted clone left a .git-less directory — every later run failed with
  // "destination path already exists and is not an empty directory" and nothing in the pipeline could
  // clear it. Clones are derived from a URL and are safe to discard.
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });

  mkdirSync(root, { recursive: true });
  try {
    git(['clone', '--depth', '1', '--no-tags', '--single-branch', '--no-recurse-submodules', url, root], paths.sourcesDir());
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    return { key, ok: false, reason: `clone failed: ${String(error.stderr || error.message).trim()}` };
  }

  const sha = git(['rev-parse', 'HEAD'], root).trim();

  // Re-inspect after any forced re-clone, then split findings into quarantine vs refusal.
  const { files, bytes, findings } = inspectTree(root);
  const refusable = findings.filter((f) => !f.quarantinable);

  if (refusable.length) {
    // Genuinely not analysable — size, depth, or file count. The reason names the actual finding kinds
    // rather than asserting "exceeds clone caps", which was simply false for a control-dir refusal.
    const reason = `tree exceeds clone caps (${[...new Set(refusable.map((f) => f.kind))].join(', ')})`;
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({ reason, findings: refusable, at: new Date().toISOString() }, null, 2)}\n`);
    rmSync(join(root, '.git'), { recursive: true, force: true });
    return { key, ok: false, root, sha, reason, findings: refusable, files, bytes };
  }

  const quarantined = quarantineControls(root, key, findings);
  const failed = quarantined.filter((q) => q.quarantine_failed);
  if (failed.length) {
    rmSync(root, { recursive: true, force: true });
    return { key, ok: false, root, sha, reason: 'could not quarantine every control file, so the repo was discarded', findings: failed };
  }

  const { findings: after } = inspectTree(root);
  if (after.length) {
    rmSync(root, { recursive: true, force: true });
    return { key, ok: false, root, sha, reason: 'control files remained after quarantine', findings: after };
  }

  return { key, ok: true, root, sha, files, bytes, quarantined, reused: false };
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