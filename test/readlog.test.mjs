// The read log is what gives a citation its meaning: it records that an agent actually looked at a
// file, so "cited_files" cannot be satisfied by naming a path. A hook writes it; the validator reads
// it. Both halves are tested here, because the check is worth nothing if either is missing.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile, canonicalIn } from '../core/lib/validate.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KEY = 'acme.tool';

// A real clone plus a real read log, because the validator checks both.
function withInstrumentedClone(files, readPaths, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gt-reads-'));
  const prev = { state: process.env.GROUNDTRUTH_STATE_DIR, clones: process.env.GROUNDTRUTH_CLONE_DIR };
  process.env.GROUNDTRUTH_STATE_DIR = join(dir, 'state');
  process.env.GROUNDTRUTH_CLONE_DIR = join(dir, 'clones');

  const clone = join(dir, 'clones', KEY);
  mkdirSync(join(clone, 'src'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(clone, name), body);

  // Read paths are clone-relative, resolved against the clone that now exists.
  const resolvedReads = readPaths.map((p) => (p.startsWith('/') ? p : join(clone, p)));

  const repoState = join(dir, 'state', 'repos', KEY);
  mkdirSync(repoState, { recursive: true });
  // Log the realpath, exactly as the hook does: a /tmp-prefixed path and a /private/tmp-prefixed one
  // name the same file, and the validator canonicalises before comparing, so the log must too.
  for (const p of resolvedReads) {
    appendFileSync(join(repoState, 'reads.jsonl'), `${JSON.stringify({ agent: 'technical-verifier', path: realpathSync(p), at: new Date().toISOString() })}\n`);
  }

  try {
    return fn(clone, repoState);
  } finally {
    for (const k of ['GROUNDTRUTH_STATE_DIR', 'GROUNDTRUTH_CLONE_DIR']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function profile(cited, { tier = 'code-verified', agent = 'technical-verifier' } = {}) {
  return {
    schema_version: 1,
    repo: { key: KEY, owner: 'acme', name: 'tool', url: 'https://github.com/acme/tool' },
    analyzed_at: '2026-10-01T00:00:00.000Z',
    prose: { what_it_does: 'a'.repeat(30), how_it_works: 'b'.repeat(30), verdict: 'c'.repeat(30), analyst_notes: '' },
    claims: [{
      claim: 'x', type: 'count', tier, evidence: 'e', cited_files: [cited], downgrade: [], correlated: false,
      quote: 'Zero runtime dependencies.', source: { path: cited === 'a' ? 'src/index.ts' : cited, line: 1 },
      verdicts: [{ agent, tier, cited_files: [cited], summary: 's' }],
    }],
    coverage: { claims_total: 1, verified: tier === 'code-verified' ? 1 : 0, self_reported: 0, contradicted: 0, unverifiable: tier === 'code-verified' ? 0 : 1, uncovered: 0 },
  };
}

function runHook(script, input, env) {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env },
  });
  return JSON.parse((result.stdout || '{}').trim() || '{}');
}

export default ({ test, assert }) => {
  test('a verdict naming a file the agent never read is rejected', () => {
    withInstrumentedClone({ 'README.md': '# doc\nZero runtime dependencies.\n', 'src/index.ts': 'export {};\nZero runtime dependencies.\n' }, ['README.md'], () => {
      const result = validateProfile(profile('src/index.ts'), { key: KEY, enforceReads: true });
      assert.ok(!result.ok, 'a citation absent from the read log was accepted');
      assert.ok(result.errors.some((e) => /read log/.test(e)), `expected a read-log error, got: ${result.errors.join('; ')}`);
    });
  });

  test('a verdict naming a file the agent did read is accepted', () => {
    withInstrumentedClone({ 'src/index.ts': 'export {};\nZero runtime dependencies.\n' }, ['src/index.ts'], () => {
      const result = validateProfile(profile('src/index.ts'), { key: KEY, enforceReads: true });
      assert.ok(result.ok, `a legitimate citation was rejected: ${result.errors.join('; ')}`);
    });
  });

  test('a citation is checked against the agent that made it, not any agent', () => {
    withInstrumentedClone({ 'README.md': '# doc\nZero runtime dependencies.\n', 'src/index.ts': 'export {};\nZero runtime dependencies.\n' }, ['src/index.ts'], () => {
      // The read happened, but not by this agent — so its citation must not be honoured.
      const result = validateProfile(profile('README.md', { agent: 'conflicts-verifier' }), { key: KEY, enforceReads: true });
      assert.ok(!result.ok, 'a verdict was credited with a read performed by a different agent');
      assert.ok(result.errors.some((e) => /conflicts-verifier/.test(e)), `expected the failing agent named: ${result.errors.join('; ')}`);
    });
  });

  test('a missing read log fails closed rather than silently passing', () => {
    withInstrumentedClone({ 'src/index.ts': 'export {};\nZero runtime dependencies.\n' }, ['src/index.ts'], (clone, repoState) => {
      // Remove the log entirely: instrumentation is absent, so the check must not silently pass.
      const log = join(repoState, 'reads.jsonl');
      if (existsSync(log)) unlinkSync(log);
      const result = validateProfile(profile('src/index.ts'), { key: KEY, enforceReads: true });
      assert.ok(!result.ok, 'a missing read log was treated as passing');
      assert.ok(result.errors.some((e) => /no read log/.test(e)), `expected a missing-log error, got: ${result.errors.join('; ')}`);
    });
  });

  test('the read log is written by the hook that observes reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-hookreads-'));
    try {
      const env = { GROUNDTRUTH_STATE_DIR: join(dir, 'state'), GROUNDTRUTH_CLONE_DIR: join(dir, 'clones'), GROUNDTRUTH_REPO_KEY: KEY };
      mkdirSync(join(dir, 'clones', KEY), { recursive: true });
      const result = runHook('scrub-read.mjs', {
        tool_name: 'Read',
        tool_input: { file_path: join(dir, 'clones', KEY, 'src/index.ts') },
        tool_response: 'export {};\n',
        agent_id: 'technical-verifier',
      }, env);

      assert.ok(!result.systemMessage, 'hook should not have flagged clean content');

      // If the hook does not write the log, the validator's check can never fire — which is exactly
      // how a check can look implemented and never run.
      const log = join(dir, 'state', 'repos', KEY, 'reads.jsonl');
      assert.ok(existsSync(log), 'the read hook wrote no read log, so cited_files can never be verified');

      const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].agent, 'technical-verifier', 'the log does not record which agent read the file');
      assert.ok(lines[0].path.endsWith(join('src', 'index.ts')), `unexpected logged path: ${lines[0].path}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a directory cannot be cited as evidence', () => {
    withInstrumentedClone({ 'src/index.ts': 'export {};\nZero runtime dependencies.\n' }, [], () => {
      for (const bad of ['.', 'src', 'src/']) {
        const result = validateProfile(profile(bad), { key: KEY, enforceReads: false });
        assert.ok(!result.ok, `a directory was accepted as a citation: ${bad}`);
        assert.ok(result.errors.some((e) => /directory|non-file/.test(e)), `expected a directory error for ${bad}`);
      }
    });
  });

  test('a symlink escaping the clone root is rejected', () => {
    withInstrumentedClone({ 'src/index.ts': 'export {};\nZero runtime dependencies.\n' }, [], (clone) => {
      try {
        symlinkSync('/etc/passwd', join(clone, 'src/escape.ts'));
      } catch {
        return; // symlinks unavailable here
      }
      const result = validateProfile(profile('src/escape.ts'), { key: KEY, enforceReads: false });
      assert.ok(!result.ok, 'a symlink pointing outside the clone was accepted');
      assert.ok(result.errors.some((e) => /symlink|outside the clone root/.test(e)), `expected an escape error, got: ${result.errors.join('; ')}`);
    });
  });

  test('git internals are not citable as project content', () => {
    withInstrumentedClone({ 'README.md': '# doc\nZero runtime dependencies.\n' }, [], (clone) => {
      mkdirSync(join(clone, '.git'), { recursive: true });
      writeFileSync(join(clone, '.git', 'config'), '[core]\n');
      const result = validateProfile(profile('.git/config'), { key: KEY, enforceReads: false });
      assert.ok(!result.ok, '.git/config was accepted as evidence');
    });
  });

  test('correlation compares real paths, so capitalisation cannot defeat it', () => {
    withInstrumentedClone({ 'README.md': '# doc\nZero runtime dependencies.\n' }, [], () => {
      const mk = (agent, cited) => ({ agent, tier: 'code-verified', cited_files: [cited], summary: 's' });
      const p = profile('README.md');
      p.claims[0].cited_files = ['README.md', 'readme.MD', './README.md'];
      p.claims[0].verdicts = [
        mk('technical-verifier', 'README.md'),
        mk('community-verifier', 'readme.MD'),
        mk('conflicts-verifier', './README.md'),
      ];
      const result = validateProfile(p, { key: KEY, enforceReads: false });
      assert.ok(!result.ok, 'three spellings of one file were treated as independent evidence');
      assert.ok(result.errors.some((e) => /same file|share evidence/.test(e)), `expected a correlation error, got: ${result.errors.join('; ')}`);
    });
  });

  test('partial overlap between agents is disclosed rather than accepted silently', () => {
    withInstrumentedClone({ 'README.md': '# doc\nZero runtime dependencies.\n', 'LICENSE': 'MIT\n' }, [], () => {
      const p = profile('README.md');
      p.claims[0].cited_files = ['README.md', 'LICENSE'];
      p.claims[0].verdicts = [
        { agent: 'technical-verifier', tier: 'code-verified', cited_files: ['README.md'], summary: 's' },
        { agent: 'community-verifier', tier: 'code-verified', cited_files: ['README.md', 'LICENSE'], summary: 's' },
      ];
      const result = validateProfile(p, { key: KEY, enforceReads: false });
      assert.ok(result.errors.some((e) => /share evidence/.test(e)), `partial overlap was not disclosed: ${result.errors.join('; ')}`);

      // Declaring it is enough to pass.
      p.claims[0].correlated = true;
      const declared = validateProfile(p, { key: KEY, enforceReads: false });
      assert.ok(declared.ok, `declaring correlated=true should satisfy the check: ${declared.errors.join('; ')}`);
    });
  });

  test('canonical path identity agrees across spellings', () => {
    withInstrumentedClone({ 'src/index.ts': 'export {};\nZero runtime dependencies.\n' }, [], (clone) => {
      assert.equal(canonicalIn(clone, 'src/index.ts'), canonicalIn(clone, './src/index.ts'));
      assert.equal(canonicalIn(clone, 'src/index.ts'), canonicalIn(clone, 'src/../src/index.ts'));
    });
  });
};