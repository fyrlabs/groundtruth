// Atomic, schema-versioned run state.
//
// Two properties matter more than anything else here:
//   1. A crash mid-write must never leave corrupt state (write tmp + rename).
//   2. Resuming must find the actual agent payloads, not just a "done" marker. A ✅ whose
//      payload is gone is a silent lie, and it is the failure mode this file exists to prevent.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, repoStateDir, stateRoot } from './paths.mjs';

export const SCHEMA_VERSION = 2;

const STATUSES = ['IDLE', 'STARTED', 'AWAITING_APPROVAL', 'IN_ANALYSIS', 'RECONCILING', 'COMPLETE', 'FAILED'];
const STAGES = ['clone', 'drift', 'analysis', 'technical', 'community', 'conflicts', 'spotcheck', 'reconcile', 'render'];

export function activeRunDir() {
  const dir = join(paths.runsDir(), 'active');
  return existsSync(join(dir, 'state.json')) ? dir : null;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomic on POSIX: rename over an existing path is a single syscall. Readers never observe a
// half-written file, so an interrupted run is always recoverable from the previous good state.
export function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function emptyState() {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: null,
    status: 'IDLE',
    started: null,
    updated: null,
    heartbeat: null,
    targets: [],
    new_repos: [],
    known_repos: [],
    discovery: { ran: false, at: null },
    approval: { required: false, at: null },
    queue: {},
    errors: [],
    next_step: 'Run /groundtruth:analyze with GitHub URLs, or with no arguments for discovery mode.',
  };
}

export function loadState() {
  const dir = activeRunDir();
  return dir ? readJson(join(dir, 'state.json'), emptyState()) : emptyState();
}

export function saveState(state) {
  const dir = activeRunDir() || join(paths.runsDir(), 'active');
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  state.updated = now;
  state.heartbeat = now;
  writeJson(join(dir, 'state.json'), { ...state, schema_version: SCHEMA_VERSION });
  return state;
}

export function updateState(fn) {
  const state = loadState();
  const next = fn(state) || state;
  return saveState(next);
}

// Runs are numbered from what exists on disk — archived runs plus the active one. An LLM
// incrementing a counter produces duplicate ids under parallel runs; the filesystem cannot.
function nextRunId() {
  const day = new Date().toISOString().slice(0, 10);
  const prefix = `groundtruth-${day}-`;
  let max = 0;
  const consider = (runId) => {
    if (typeof runId !== 'string' || !runId.startsWith(prefix)) return;
    const n = Number.parseInt(runId.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  };

  for (const name of existsSync(paths.runsDir()) ? readdirSync(paths.runsDir()) : []) {
    if (name === 'active') {
      // The active run's id lives inside its state file, not its directory name.
      consider(readJson(join(paths.runsDir(), 'active', 'state.json'), {})?.run_id);
    } else {
      consider(name);
    }
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

export function startRun({ targets = [], newRepos = [], knownRepos = [], discoveryRan = false } = {}) {
  const runId = nextRunId();
  // The active run lives at a stable path so every reader (including `state.mjs show`) finds it
  // without first resolving a pointer. Prior runs are archived by id rather than deleted, so an
  // interrupted run's state is still recoverable after the next run starts.
  mkdirSync(paths.runsDir(), { recursive: true });
  const previous = activeRunDir();
  const previousState = previous ? readJson(join(previous, 'state.json'), null) : null;
  if (previous && previousState?.run_id) {
    const archive = join(paths.runsDir(), previousState.run_id);
    if (existsSync(archive)) rmSync(archive, { recursive: true, force: true });
    renameSync(previous, archive);
  }
  const dir = join(paths.runsDir(), 'active');
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'state.json'), {
    ...emptyState(),
    run_id: runId,
    status: 'STARTED',
    started: new Date().toISOString(),
    updated: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    targets,
    new_repos: newRepos,
    known_repos: knownRepos,
    discovery: { ran: discoveryRan, at: discoveryRan ? new Date().toISOString() : null },
    next_step: 'Clone new repos, then drift-check known repos.',
  });

  return { ...emptyState(), run_id: runId, status: 'STARTED', targets, new_repos: newRepos, known_repos: knownRepos };
}

export function setRepoStage(key, stage, value, detail = null) {
  const dir = repoStateDir(key);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'stages.json');
  const stages = readJson(file, {});
  stages[stage] = { value, detail, at: new Date().toISOString() };
  writeJson(file, stages);
  updateState((state) => {
    state.queue[key] = { ...(state.queue[key] || {}), [stage]: value };
    return state;
  });
}

export function readRepoStage(key) {
  return readJson(join(repoStateDir(key), 'stages.json'), {});
}

export function readPayload(key, stage) {
  return readJson(join(repoStateDir(key), `${stage}.json`), null);
}

// A stage counts as done only when its payload exists. Status alone is how the pipeline used to
// claim success over a lost result.
export function repoProgress(key) {
  const stages = readRepoStage(key);
  const done = STAGES.filter((s) => stages[s]?.value === 'done' && (s === 'clone' || s === 'drift' || readPayload(key, s) !== null));
  return { stages, complete: STAGES.filter((s) => done.includes(s)) };
}

export function writePayload(key, stage, value) {
  const dir = repoStateDir(key);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, `${stage}.json`), value);
  setRepoStage(key, stage, 'done');
  return value;
}

export function logError(key, stage, message) {
  updateState((state) => {
    state.errors.push({ repo: key, stage, message: String(message), at: new Date().toISOString() });
    return state;
  });
}

export function nextStepFor(state) {
  if (state.status === 'IDLE') return 'Start a run: /groundtruth:analyze <url> or /groundtruth:analyze with no arguments for discovery.';
  if (state.status === 'AWAITING_APPROVAL') return 'Ask the user to approve the analysis queue, then: state.mjs approve';
  if (state.status === 'IN_ANALYSIS') return 'Dispatch the analysis stages for each queued repo (see skills/analyze/SKILL.md Step 5).';
  if (state.status === 'RECONCILING') return 'Dispatch the meta-reconciler per repo, then render.mjs <owner__repo>.';
  if (state.status === 'FAILED') return 'Show the errors and ask whether to retry or skip the failed stage.';
  return 'Complete — start a new run or re-render with render.mjs --all.';
}

export { STATUSES, STAGES, stateRoot };