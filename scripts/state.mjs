#!/usr/bin/env node
// Run state CLI. The orchestrator never edits state files by hand.

import { ensureStateRoot, paths } from '../core/lib/paths.mjs';
import {
  emptyState, activeRunDir, loadState, saveState, startRun, nextStepFor, logError,
  readRepoStage, readPayload, writePayload, setRepoStage, repoProgress,
} from '../core/lib/state.mjs';

ensureStateRoot();

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

  case 'reset': {
    if (!rest.includes('--yes')) {
      process.stderr.write(`refusing to delete state at ${paths.runsDir()} without --yes\n`);
      process.exit(1);
    }
    const { rmSync } = await import('node:fs');
    rmSync(paths.runsDir(), { recursive: true, force: true });
    rmSync(paths.reposDir(), { recursive: true, force: true });
    ensureStateRoot();
    process.stdout.write('state cleared\n');
    break;
  }

  default:
    process.stderr.write(`usage: state.mjs <show|start|approve|fail|stage|payload|progress|reset>\n`);
    process.exit(1);
}