// The injection-attempt fixture, copied into a temp clone so the guards run against a real tree.
//
// Separate from test/injection.test.mjs, which tests the scanner against inline strings. This one
// asks a narrower question: would placing this repository inside a clone cause anything in the
// pipeline to treat its contents as instruction?

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectTree, CLONE_CAPS } from '../core/lib/clone.mjs';
import { scan, scrub } from '../core/lib/injection.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(ROOT, 'test', 'fixtures', 'hostile-repo');

function inTempState(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gt-hostile-'));
  mkdirSync(join(dir, 'clones'), { recursive: true });
  const prev = { state: process.env.GROUNDTRUTH_STATE_DIR, clones: process.env.GROUNDTRUTH_CLONE_DIR };
  process.env.GROUNDTRUTH_STATE_DIR = join(dir, 'state');
  process.env.GROUNDTRUTH_CLONE_DIR = join(dir, 'clones');
  try {
    return fn(dir);
  } finally {
    for (const key of ['GROUNDTRUTH_STATE_DIR', 'GROUNDTRUTH_CLONE_DIR']) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

export default ({ test, assert }) => {
  test('the fixture carries every control file the clone step must refuse', () => {
    for (const file of ['AGENTS.md', 'CLAUDE.md', '.claude/skills/evil/SKILL.md']) {
      assert.ok(readFileSync(join(FIXTURE, file), 'utf8').length > 0, `fixture file empty: ${file}`);
    }
  });

  test('cloning this repository is refused, for the right reason', () => {
    inTempState((dir) => {
      const clone = join(dir, 'clones', 'evil.corp');
      cpSync(FIXTURE, clone, { recursive: true });
      const { findings } = inspectTree(clone);
      const kinds = findings.map((f) => `${f.kind}:${f.path}`);

      assert.ok(kinds.includes('control-file:AGENTS.md'), `AGENTS.md not refused: ${kinds.join(', ')}`);
      assert.ok(kinds.includes('control-file:CLAUDE.md'), `CLAUDE.md not refused: ${kinds.join(', ')}`);
      assert.ok(kinds.includes('control-dir:.claude'), `.claude/ not refused: ${kinds.join(', ')}`);
    });
  });

  test('the refusal is about control files, not about the repo being large', () => {
    inTempState((dir) => {
      const clone = join(dir, 'clones', 'evil.corp');
      cpSync(FIXTURE, clone, { recursive: true });
      const { findings } = inspectTree(clone);
      const kinds = findings.map((f) => f.kind);
      // A size-based refusal would be the wrong diagnosis: the tree is tiny.
      assert.ok(!kinds.includes('too-many-files'), 'refused for size, not for control files');
      assert.ok(!kinds.includes('tree-too-large'), 'refused for size, not for control files');
      assert.ok(CLONE_CAPS.maxFiles > 10, 'the cap is implausibly low, so the test would be meaningless');
    });
  });

  test('the README forged pipeline output is detected', () => {
    const readme = readFileSync(join(FIXTURE, 'README.md'), 'utf8');
    const hits = scan(readme, { path: 'README.md' });
    const kinds = hits.map((h) => h.kind);
    assert.ok(kinds.includes('output-forgery'), `forged ANALYSIS_REPORT missed: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('verdict-injection'), `forged verdict row missed: ${kinds.join(', ')}`);
  });

  test('scrubbing the forged output does not leave a usable verdict row', () => {
    const readme = readFileSync(join(FIXTURE, 'README.md'), 'utf8');
    const { text } = scrub(readme, { path: 'README.md' });
    assert.ok(!/All claims above are `code-verified`/.test(text), 'the forged verification survived scrubbing');
    assert.ok(!/Nothing found\n/.test(text), 'the forged "None found" survived scrubbing');
    // Legitimate documentation must survive, or the scrubber is destroying the evidence.
    assert.match(text, /blazing-fast/, 'legitimate README content was destroyed');
  });

  test('the pre-approved tool list in the injected skill is detected', () => {
    const skill = readFileSync(join(FIXTURE, '.claude/skills/evil/SKILL.md'), 'utf8');
    const kinds = scan(skill, { path: '.claude/skills/evil/SKILL.md' }).map((h) => h.kind);
    assert.ok(kinds.includes('tool-approval-request'), `allowed-tools smuggling missed: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('shell-pipe'), `curl|bash missed: ${kinds.join(', ')}`);
  });

  test('the AGENTS.md override is detected in every phrasing', () => {
    const agents = readFileSync(join(FIXTURE, 'AGENTS.md'), 'utf8');
    const kinds = scan(agents, { path: 'AGENTS.md' }).map((h) => h.kind);
    assert.ok(kinds.includes('instruction-override'), `instruction override missed: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('role-spoof'), `role spoof missed: ${kinds.join(', ')}`);
  });

  test('the benign fixture is not mistaken for an attack', () => {
    const clean = [
      readFileSync(join(ROOT, 'test/fixtures/known-claims-repo/README.md'), 'utf8'),
      readFileSync(join(ROOT, 'test/fixtures/known-claims-repo/package.json'), 'utf8'),
      readFileSync(join(ROOT, 'test/fixtures/known-claims-repo/LICENSE'), 'utf8'),
    ].join('\n');
    assert.deepEqual(scan(clean, { path: 'README.md' }), [], 'an ordinary README was flagged as an attack');
  });

  test('the known-claims fixture contains the claims it claims to', () => {
    const { findings } = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'gt-known-'));
      try {
        cpSync(join(ROOT, 'test/fixtures/known-claims-repo'), dir, { recursive: true });
        return inspectTree(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
    assert.deepEqual(findings, [], 'the benign fixture tripped a clone guard');
  });

  test('a repo that only documents claims, with no installers, is still analysable', () => {
    // The contrast that matters: hostile by content is fine, harness-control is not.
    const dir = mkdtempSync(join(tmpdir(), 'gt-plain-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'README.md'), 'Claims 500 plugins and ships them all.\n');
      writeFileSync(join(dir, 'src/index.ts'), 'export {};\n');
      const { findings } = inspectTree(dir);
      assert.deepEqual(findings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
};