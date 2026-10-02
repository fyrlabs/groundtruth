#!/usr/bin/env node
// Run state CLI. The orchestrator never edits state files by hand.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateRoot, paths } from '../core/lib/paths.mjs';
import {
  emptyState, activeRunDir, loadState, saveState, startRun, nextStepFor, logError,
  readPayload, setRepoStage, repoProgress, writeJson,
} from '../core/lib/state.mjs';

ensureStateRoot();

function readProfile(key) {
  try {
    return JSON.parse(readFileSync(join(paths.reposDir(), key, 'profile.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The SHA a repo was analysed at. drift.mjs reads this; without it every repo is skipped and the
// drift stage is a permanent no-op, which is how "never re-analysed unless the commit changed" was
// silently unimplemented.
function writeManifest(key, record) {
  const dir = join(paths.reposDir(), key);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'manifest.json'), record);
}



const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? '' : rest[i + 1] || '';
};
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

switch (cmd) {
  case 'show': {
    const state = loadState();
    const queues = Object.entries(state.queue || {});
    process.stdout.write(`run:      ${state.run_id || '(none)'}\n`);
    process.stdout.write(`status:   ${state.status}\n`);
    process.stdout.write(`started:  ${state.started || '-'}\n`);
    process.stdout.write(`heartbeat: ${state.heartbeat || '-'}\n`);
    process.stdout.write(`state:    ${activeRunDir() || '(no active run)'}\n`);
    if (queues.length) {
      process.stdout.write('\nrepos:\n');
      for (const [key, stages] of queues) {
        const done = Object.entries(stages).filter(([, v]) => v === 'done').map(([k]) => k);
        const failed = Object.entries(stages).filter(([, v]) => v === 'failed').map(([k]) => k);
        process.stdout.write(`  ${key}: ${done.length ? `done[${done.join(',')}]` : 'pending'}${failed.length ? ` FAILED[${failed.join(',')}]` : ''}\n`);
      }
    }
    if (state.errors?.length) {
      process.stdout.write('\nerrors:\n');
      for (const e of state.errors) process.stdout.write(`  ${e.repo}/${e.stage}: ${e.message}\n`);
    }
    process.stdout.write(`\nnext:     ${nextStepFor(state)}\n`);
    break;
  }

  case 'start': {
    const state = startRun({
      targets: list(flag('targets')),
      newRepos: list(flag('new')),
      knownRepos: list(flag('known')),
      discoveryRan: rest.includes('--discovery'),
    });
    process.stdout.write(`${state.run_id}\n`);
    break;
  }

  case 'approve': {
    const state = loadState();
    if (state.status === 'COMPLETE' || state.status === 'IDLE') {
      process.stderr.write('no run awaiting approval\n');
      process.exit(1);
    }
    state.approval = { required: false, at: new Date().toISOString() };
    state.status = 'IN_ANALYSIS';
    state.next_step = 'Dispatch analysis stages for each queued repo.';
    saveState(state);
    process.stdout.write('approved\n');
    break;
  }

  case 'fail': {
    logError(flag('repo'), flag('stage') || 'unknown', rest.filter((r) => !r.startsWith('--')).join(' ') || 'unspecified');
    process.stdout.write('logged\n');
    break;
  }

  case 'stage': {
    const [key, stage, value] = rest;
    setRepoStage(key, stage, value || 'pending');
    process.stdout.write(`${key}/${stage}=${value || 'pending'}\n`);
    break;
  }

  case 'payload': {
    const [key, stage] = rest;
    const value = readPayload(key, stage);
    if (value === null) {
      process.stderr.write(`no payload for ${key}/${stage}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    break;
  }

  case 'progress': {
    const key = rest[0];
    const { stages } = repoProgress(key);
    process.stdout.write(`${JSON.stringify(stages, null, 2)}\n`);
    break;
  }

  case 'registry': {
    // The classifier needs the known-repo set to separate new from drift-check. Derived from the
    // profiles on disk rather than a hand-maintained file, so it cannot drift from reality.
    const repos = existsSync(paths.reposDir()) ? readdirSync(paths.reposDir()) : [];
    const known = [];
    for (const key of repos) {
      const profile = readProfile(key);
      if (!profile?.repo?.url) continue;
      known.push({
        key,
        url: profile.repo.url,
        owner: profile.repo.owner,
        name: profile.repo.name,
        status: profile.health?.status || 'unknown',
        license: profile.license?.actual || null,
        last_analyzed: profile.analyzed_at?.slice(0, 10) || null,
        sha: profile.repo.sha || null,
        summary: profile.prose?.what_it_does || null,
      });
    }
    if (rest.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ repos: known }, null, 2)}\n`);
    } else {
      process.stdout.write(`${known.length} known repo(s)\n`);
      for (const r of known) process.stdout.write(`  ${r.key.padEnd(28)} ${String(r.status).padEnd(20)} ${r.last_analyzed || '-'}  ${r.summary ? r.summary.slice(0, 60) : ''}\n`);
    }
    break;
  }

  case 'record-manifest': {
    const [key, sha, version = '', ref = ''] = rest.filter((r) => !r.startsWith('--'));
    if (!key || !sha) {
      process.stderr.write('usage: state.mjs record-manifest <owner.repo> <sha> [version] [ref]\n');
      process.exit(1);
    }
    writeManifest(key, { sha, version, ref, recorded_at: new Date().toISOString() });
    process.stdout.write(`recorded ${key}@${String(sha).slice(0, 12)}\n`);
    break;
  }

  case 'record-models': {
    const raw = rest.find((r) => r.startsWith('{'));
    if (!raw) {
      process.stderr.write('usage: state.mjs record-models \'{"fast":"haiku","medium":"sonnet"}\'\n');
      process.exit(1);
    }
    let resolved;
    try {
      resolved = JSON.parse(raw);
    } catch (error) {
      process.stderr.write(`record-models: invalid JSON (${error.message})\n`);
      process.exit(1);
    }
    const state = loadState();
    state.models = { ...resolved, recorded_at: new Date().toISOString() };
    saveState(state);
    process.stdout.write(`recorded models: ${Object.entries(resolved).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);
    break;
  }

  case 'finish': {
    const state = loadState();
    if (state.status === 'IDLE' || !state.run_id) {
      process.stderr.write('no run in progress\n');
      process.exit(1);
    }
    state.status = 'COMPLETE';
    state.next_step = 'Complete — start a new run or re-render with render.mjs --all.';
    saveState(state);
    process.stdout.write(`run ${state.run_id} marked COMPLETE\n`);
    break;
  }

  case 'reset': {
    if (!rest.includes('--yes')) {
      process.stderr.write(`refusing to delete state at ${paths.runsDir()} without --yes\n`);
      process.exit(1);
    }
    rmSync(paths.runsDir(), { recursive: true, force: true });
    rmSync(paths.reposDir(), { recursive: true, force: true });
    ensureStateRoot();

function readProfile(key) {
  try {
    return JSON.parse(readFileSync(join(paths.reposDir(), key, 'profile.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The SHA a repo was analysed at. drift.mjs reads this; without it every repo is skipped and the
// drift stage is a permanent no-op, which is how "never re-analysed unless the commit changed" was
// silently unimplemented.
function writeManifest(key, record) {
  const dir = join(paths.reposDir(), key);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'manifest.json'), record);
}


    process.stdout.write('state cleared\n');
    break;
  }

  default:
    // Non-zero, so a caller invoking a subcommand that does not exist sees failure rather than
    // treating the usage message as success. Two orchestrator steps were silently dead because of
    // this exit code.
    process.stderr.write(`unknown subcommand: ${cmd}\n`);
    process.stderr.write('usage: state.mjs <show|start|approve|fail|stage|payload|progress|registry|record-manifest|record-models|finish|reset>\n');
    process.exit(2);
}