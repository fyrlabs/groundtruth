// State must survive interruption, and a "done" marker must never outlive its payload.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoKey, repoParts, stateRoot, cloneRoot, ensureStateRoot, paths } from '../core/lib/paths.mjs';
import { loadState, saveState, startRun, writeJson, readJson, setRepoStage, readPayload, repoProgress, writePayload, emptyState } from '../core/lib/state.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function inTempState(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gt-st-'));
  const prev = process.env.GROUNDTRUTH_STATE_DIR;
  process.env.GROUNDTRUTH_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.GROUNDTRUTH_STATE_DIR;
    else process.env.GROUNDTRUTH_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

export default ({ test, assert }) => {
  test('repo identity distinguishes same-named repos in different orgs', () => {
    assert.equal(repoKey('https://github.com/acme/tool'), 'acme.tool');
    assert.equal(repoKey('https://github.com/other/tool'), 'other.tool');
    assert.match(repoKey('https://github.com/FyrLabs/GroundTruth.git'), /^[a-z0-9.-]+\.[a-z0-9._-]+$/);
  });

  test('repo identity rejects non-GitHub and malformed URLs', () => {
    for (const bad of ['https://gitlab.com/a/b', 'not a url', '', 'https://github.com/onlyowner', 'https://github.com/a/b/c']) {
      assert.equal(repoKey(bad), null, `accepted: ${bad}`);
    }
  });

  test('repo key round-trips to owner and repo', () => {
    const { owner, repo } = repoParts(repoKey('https://github.com/acme/my-tool'));
    assert.equal(owner, 'acme');
    assert.equal(repo, 'my-tool');
  });

  test('state root honours the explicit override', () => {
    inTempState((dir) => {
      assert.equal(stateRoot(), dir);
      ensureStateRoot();
      for (const sub of ['runs', 'repos', 'output']) {
        assert.ok(existsSync(join(dir, sub)), `missing ${sub}`);
      }
      // Clones must NOT live under the state root, which defaults inside the project tree: a repo
      // there is loaded as project instructions the moment an agent reads a file in it.
      assert.ok(!existsSync(join(dir, 'sources')), 'clones must not be created under the state root');
    });
  });

  test('state writes are atomic — no partial file survives', () => {
    inTempState((dir) => {
      ensureStateRoot();
      const file = join(dir, 'atomic.json');
      writeJson(file, { v: 1, big: 'x'.repeat(100000) });
      const parsed = readJson(file);
      assert.equal(parsed.v, 1);
      assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')), 'a temp file was left behind');
    });
  });

  test('a fresh install has no run in progress', () => {
    inTempState(() => {
      ensureStateRoot();
      const state = loadState();
      assert.equal(state.status, 'IDLE');
      assert.equal(state.run_id, null);
    });
  });

  test('run ids increment and never collide within a day', () => {
    inTempState(() => {
      ensureStateRoot();
      const a = startRun({ targets: ['https://github.com/x/one'] });
      const b = startRun({ targets: ['https://github.com/x/two'] });
      assert.ok(a.run_id !== b.run_id, `collided: ${a.run_id}`);
      assert.match(a.run_id, /^groundtruth-\d{4}-\d{2}-\d{2}-\d{3}$/);
    });
  });

  test('a run survives being read back after other state changed', () => {
    inTempState(() => {
      ensureStateRoot();
      startRun({ targets: ['https://github.com/x/one'], newRepos: ['x.one'] });
      saveState({ ...loadState(), status: 'IN_ANALYSIS' });
      assert.equal(loadState().status, 'IN_ANALYSIS');
      assert.equal(loadState().targets[0], 'https://github.com/x/one');
    });
  });

  test('a stage marked done without a payload does not count as complete', () => {
    inTempState(() => {
      ensureStateRoot();
      startRun({ newRepos: ['acme.tool'] });
      setRepoStage('acme.tool', 'technical', 'done');
      assert.equal(readPayload('acme.tool', 'technical'), null, 'expected no payload yet');
      const { complete } = repoProgress('acme.tool');
      assert.ok(!complete.includes('technical'), 'a stage with no payload was reported complete');
    });
  });

  test('a stage with a payload is complete and survives a fresh read', () => {
    inTempState(() => {
      ensureStateRoot();
      startRun({ newRepos: ['acme.tool'] });
      writePayload('acme.tool', 'technical', { verdicts: [{ claim_id: 'c1' }] });
      const { complete } = repoProgress('acme.tool');
      assert.ok(complete.includes('technical'), 'a stage with a payload was not reported complete');
      assert.equal(readPayload('acme.tool', 'technical').verdicts.length, 1);
    });
  });

  test('run state never contains a placeholder repository URL', () => {
    inTempState((dir) => {
      ensureStateRoot();
      startRun({ targets: ['https://github.com/real-org/real-repo'], newRepos: ['real-org.real-repo'] });
      const raw = readFileSync(join(dir, 'runs', 'active', 'state.json'), 'utf8');
      assert.ok(!raw.includes('org/repo'), 'a placeholder URL leaked into run state');
    });
  });

  test('corrupt state falls back to idle rather than crashing the pipeline', () => {
    inTempState((dir) => {
      ensureStateRoot();
      startRun({});
      writeFileSync(join(dir, 'runs', 'active', 'state.json'), '{ this is not json');
      const state = loadState();
      assert.equal(state.status, 'IDLE');
    });
  });

  test('empty state carries a schema version', () => {
    assert.equal(emptyState().schema_version, 2);
  });

  test('clones live outside the project tree', () => {
    inTempState(() => {
      // The whole reason for the split: the harness loads CLAUDE.md and .claude/skills/ from any
      // directory an agent reads in, so a clone inside the project installs its own instructions.
      assert.ok(!cloneRoot().startsWith(stateRoot()), `clones at ${cloneRoot()} are inside state root ${stateRoot()}`);
    });
    assert.equal(paths.sourcesDir(), cloneRoot());
  });

  test('the clone root honours an explicit override', () => {
    const prev = process.env.GROUNDTRUTH_CLONE_DIR;
    process.env.GROUNDTRUTH_CLONE_DIR = '/tmp/explicit-clones';
    try {
      assert.equal(cloneRoot(), '/tmp/explicit-clones');
    } finally {
      if (prev === undefined) delete process.env.GROUNDTRUTH_CLONE_DIR;
      else process.env.GROUNDTRUTH_CLONE_DIR = prev;
    }
  });
};
