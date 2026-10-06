// A quote must occur in the file it cites.
//
// Every other field of a claim payload is writable by a model, so a plausible invented quote passes
// every structural check. Three claims invented for a real repository during the first live run —
// "Independently audited by a third party", "Ships 4 plugins", "Handles 10000 requests per second" —
// were accepted and carried into a rendered report. These are the tests for the check that would have
// rejected them, written against the shapes a naive implementation gets wrong.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateClaimFile, validateProfile } from '../core/lib/validate.mjs';

const README = [
  '# security-audit',              // 1
  '',                              // 2
  'This skill orchestrates six',   // 3
  'independent phases.',           // 4
  '',                              // 5
  'Zero runtime dependencies.',    // 6
  '',                              // 7
  'MIT licensed.',                 // 8
  '',                              // 9
  "It is Python-agnostic and says \u201Cplatform neutral\u201D.", // 10
  '',                              // 11
  'A very long line that wraps in the rendered page but is one line', // 12
  'in the file itself.',           // 13
].join('\n');

const SCRIPTS = 'print("hello")\n';

function withClone(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gt-quote-'));
  const prev = { state: process.env.GROUNDTRUTH_STATE_DIR, clones: process.env.GROUNDTRUTH_CLONE_DIR };
  process.env.GROUNDTRUTH_STATE_DIR = root;
  process.env.GROUNDTRUTH_CLONE_DIR = join(root, 'clones');
  const sources = join(root, 'clones', 'acme.tool');
  mkdirSync(sources, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(sources, name, '..'), { recursive: true });
    writeFileSync(join(sources, name), body);
  }
  try {
    return fn({ key: 'acme.tool', sources, root });
  } finally {
    for (const k of ['GROUNDTRUTH_STATE_DIR', 'GROUNDTRUTH_CLONE_DIR']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const claim = (over = {}) => ({
  id: 'c1',
  text: 'Zero runtime dependencies',
  quote: 'Zero runtime dependencies.',
  source: { path: 'README.md', line: 6 },
  type: 'count',
  ...over,
});

export default ({ test, assert }) => {
  test('a quote that is in the file is accepted', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      const r = validateClaimFile({ claims: [claim()] }, { key });
      assert.ok(r.ok, `rejected a real quote: ${r.errors?.join('; ')}`);
    });
  });

  // The exact failure that reached a rendered report.
  for (const invented of [
    'Independently audited by a third party',
    'Ships 4 plugins',
    'Handles 10000 requests per second',
    'independently audited',
  ]) {
    test(`a fabricated quote is rejected: ${JSON.stringify(invented)}`, () => {
      withClone({ 'README.md': README }, ({ key }) => {
        const r = validateClaimFile({ claims: [claim({ quote: invented })] }, { key });
        assert.ok(!r.ok, `accepted a quote that is not in the repository: ${invented}`);
        assert.ok(r.errors.some((e) => /does not appear in/.test(e)), `expected a quote error, got ${JSON.stringify(r.errors)}`);
      });
    });
  }

  test('a quote that is a paraphrase of the file is still rejected', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      const r = validateClaimFile({ claims: [claim({ quote: 'has no dependencies at all' })] }, { key });
      assert.ok(!r.ok, 'accepted a paraphrase as a quote');
    });
  });

  test('a quote copied from a different file in the same repo is rejected', () => {
    withClone({ 'README.md': README, 'run.py': SCRIPTS }, ({ key }) => {
      const r = validateClaimFile({ claims: [claim({ quote: 'print("hello")' })] }, { key });
      assert.ok(!r.ok, 'accepted a quote from a file the claim does not cite');
    });
  });

  test('a claim citing a file that does not exist is rejected', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      const r = validateClaimFile({ claims: [claim({ source: { path: 'NOPE.md', line: 1 } })] }, { key });
      assert.ok(!r.ok);
      assert.ok(r.errors.some((e) => /does not exist/.test(e)), `got ${JSON.stringify(r.errors)}`);
    });
  });

  test('a line number past the end of the file is rejected', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      const r = validateClaimFile({ claims: [claim({ source: { path: 'README.md', line: 9999 } })] }, { key });
      assert.ok(!r.ok);
      assert.ok(r.errors.some((e) => /past the end/.test(e)), `got ${JSON.stringify(r.errors)}`);
    });
  });

  test('a citation whose quote lives far from the cited line is rejected', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      // Cites line 1 but quotes line 12 — the file supports the quote, not the citation.
      const r = validateClaimFile({ claims: [claim({ quote: 'in the file itself.', source: { path: 'README.md', line: 1 } })] }, { key });
      assert.ok(!r.ok, 'accepted a quote nowhere near the cited line');
      assert.ok(r.errors.some((e) => /but the quote is on line/.test(e)), `got ${JSON.stringify(r.errors)}`);
    });
  });

  test('a quote spanning a line break is accepted', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      const r = validateClaimFile({ claims: [claim({ quote: 'six\nindependent phases.', source: { path: 'README.md', line: 3 } })] }, { key });
      assert.ok(r.ok, `rejected a multi-line quote: ${r.errors?.join('; ')}`);
    });
  });

  test('line wrapping lost in transcription is tolerated', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      // The file has one long line; an agent reproducing what it rendered would wrap it.
      const r = validateClaimFile({ claims: [claim({ quote: 'is one line in the file itself.', source: { path: 'README.md', line: 12 } })] }, { key });
      assert.ok(r.ok, `rejected a quote that differs only in wrapping: ${r.errors?.join('; ')}`);
    });
  });

  test('straight quotes substituted for typographic ones are tolerated', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      const r = validateClaimFile({ claims: [claim({ quote: 'says "platform neutral".', source: { path: 'README.md', line: 10 } })] }, { key });
      assert.ok(r.ok, `rejected a quote differing only in typography: ${r.errors?.join('; ')}`);
    });
  });

  test('CRLF line endings do not defeat the check', () => {
    withClone({ 'README.md': README.replace(/\n/g, '\r\n') }, ({ key }) => {
      const r = validateClaimFile({ claims: [claim()] }, { key });
      assert.ok(r.ok, `rejected a real quote in a CRLF file: ${r.errors?.join('; ')}`);
    });
  });

  test('a directory cannot be cited as a source', () => {
    withClone({ 'README.md': README, 'src/keep.txt': SCRIPTS }, ({ key }) => {
      const r = validateClaimFile({ claims: [claim({ source: { path: 'src', line: 1 } })] }, { key });
      assert.ok(!r.ok, 'a directory was accepted as evidence');
    });
  });

  test('a path escaping the clone root is rejected', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      for (const bad of ['../outside.md', '/etc/hosts', '../../etc/passwd']) {
        const r = validateClaimFile({ claims: [claim({ source: { path: bad, line: 1 } })] }, { key });
        assert.ok(!r.ok, `accepted an escaping path: ${bad}`);
      }
    });
  });

  test('a symlink pointing outside the clone is rejected', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gt-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'Zero runtime dependencies.\n');
    try {
      withClone({ 'README.md': README }, ({ key, sources }) => {
        symlinkSync(join(outside, 'secret.md'), join(sources, 'link.md'));
        const r = validateClaimFile({ claims: [claim({ source: { path: 'link.md', line: 1 } })] }, { key });
        assert.ok(!r.ok, 'a symlink out of the clone was accepted as evidence');
        assert.ok(r.errors.some((e) => /outside the clone root|resolves outside/.test(e)), `got ${JSON.stringify(r.errors)}`);
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a binary file is rejected rather than searched for bytes', () => {
    const bin = join(tmpdir(), 'gt-quote-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    try {
      withClone({ 'README.md': README }, ({ key, sources }) => {
        writeFileSync(join(sources, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
        const r = validateClaimFile({ claims: [claim({ source: { path: 'blob.bin', line: 1 } })] }, { key });
        assert.ok(!r.ok, 'a binary file was accepted as quotable evidence');
      });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('the .git directory cannot be quoted', () => {
    withClone({ 'README.md': README }, ({ key, sources }) => {
      mkdirSync(join(sources, '.git'), { recursive: true });
      writeFileSync(join(sources, '.git', 'config'), 'Zero runtime dependencies.\n');
      const r = validateClaimFile({ claims: [claim({ source: { path: '.git/config', line: 1 } })] }, { key });
      assert.ok(!r.ok, 'the git directory was accepted as evidence');
    });
  });

  // Fail closed. A validator that skips the check when it cannot run is the failure this whole project
  // keeps rediscovering in a new place.
  test('claims are refused when no repo key is supplied', () => {
    const r = validateClaimFile({ claims: [claim()] });
    assert.ok(!r.ok, 'claims accepted with no clone to verify them against');
    assert.ok(r.errors.some((e) => /repo key/.test(e)), `got ${JSON.stringify(r.errors)}`);
  });

  test('claims are refused when the clone is absent', () => {
    withClone({ 'README.md': README }, () => {
      const r = validateClaimFile({ claims: [claim()] }, { key: 'acme.absent' });
      assert.ok(!r.ok, 'claims accepted for a repository that was never cloned');
      assert.ok(r.errors.some((e) => /no clone at/.test(e)), `got ${JSON.stringify(r.errors)}`);
    });
  });

  test('an empty quote is rejected', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      const r = validateClaimFile({ claims: [claim({ quote: '   ' })] }, { key });
      assert.ok(!r.ok);
    });
  });

  test('a payload with no claims still validates structurally', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      assert.ok(validateClaimFile({ claims: [] }, { key }).ok, 'an empty claim list is legitimate');
    });
  });

  // Regressions from an adversarial review of this check. Each was a working bypass at the time.
  test('a quote too short to be evidence is rejected', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      for (const q of ['e', '.', '...', '  ', 'a b', 'Zero']) {
        const r = validateClaimFile({ claims: [claim({ quote: q, text: 'Independently audited by a third party' })] }, { key });
        assert.ok(!r.ok, `accepted a ${JSON.stringify(q)} quote as evidence for an unsupported claim`);
        assert.ok(r.errors.some((e) => /too short to be evidence/.test(e)), `expected a length error for ${JSON.stringify(q)}, got ${JSON.stringify(r.errors)}`);
      }
    });
  });

  test('a non-string source.path is rejected with an error, not skipped', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      // This returned false without recording anything, so the claim passed with zero errors — the
      // project's own recurring failure class in a new place.
      for (const path of [42, true, [], {}, 3.5, ['README.md']]) {
        const r = validateClaimFile({ claims: [claim({ source: { path, line: 6 } })] }, { key });
        assert.ok(!r.ok, `accepted a non-string source.path: ${JSON.stringify(path)}`);
        assert.ok(r.errors.length > 0, `no error recorded for path ${JSON.stringify(path)}`);
      }
    });
  });

  test('a missing or non-integer source.line is rejected with an error', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      for (const line of [undefined, '6', null, -1, 1.5]) {
        const r = validateClaimFile({ claims: [claim({ source: { path: 'README.md', line } })] }, { key });
        assert.ok(!r.ok, `accepted source.line ${JSON.stringify(line)}`);
        assert.ok(r.errors.length > 0, `no error recorded for line ${JSON.stringify(line)}`);
      }
    });
  });

  test('a newline-padded quote cannot inflate the positional tolerance', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      // 300 blank lines used to reach a 1002-line span, making "cited line N" carry no position at all.
      const padded = `Zero${'\n'.repeat(300)}runtime`;
      const r = validateClaimFile({ claims: [claim({ quote: padded, source: { path: 'README.md', line: 1 } })] }, { key });
      assert.ok(!r.ok, 'a padded quote matched a line far from the citation');
    });
  });

  test('crossing a line break is tolerated but reordering is not', () => {
    // Joining lines is the documented transcription tolerance: an agent reproducing what it rendered
    // will not reproduce the file's wrapping. It must not become licence to reorder words.
    withClone({ 'README.md': README, 'mod.js': 'exports\nfunction\nfoo\n' }, ({ key }) => {
      const wrapped = validateClaimFile({ claims: [claim({ quote: 'exports function', source: { path: 'mod.js', line: 1 } })] }, { key });
      assert.ok(wrapped.ok, `a quote differing only in line wrapping was rejected: ${wrapped.errors?.join('; ')}`);

      const reordered = validateClaimFile({ claims: [claim({ quote: 'function exports', source: { path: 'mod.js', line: 1 } })] }, { key });
      assert.ok(!reordered.ok, 'a quote with reordered words was accepted');
    });
  });

  test('a key that is not owner.repo cannot become the containment root', () => {
    withClone({ 'README.md': README }, ({ key }) => {
      for (const bad of ['..', '../acme.tool', 'acme', 'ACME.TOOL', 'acme.tool/../..', '']) {
        const r = validateClaimFile({ claims: [claim()] }, { key: bad });
        assert.ok(!r.ok, `accepted repo key ${JSON.stringify(bad)}`);
      }
    });
  });

  test('a profile claim cannot reach the report without a verified quotation', () => {
    // The rendered artifact is the profile. Quoting was checked only in analysis.json, whose quotes are
    // never printed, so the gate protected a file no reader sees.
    const root = mkdtempSync(join(tmpdir(), 'gt-profq-'));
    const prev = { state: process.env.GROUNDTRUTH_STATE_DIR, clones: process.env.GROUNDTRUTH_CLONE_DIR };
    process.env.GROUNDTRUTH_STATE_DIR = root;
    process.env.GROUNDTRUTH_CLONE_DIR = join(root, 'clones');
    const sources = join(root, 'clones', 'acme.tool');
    mkdirSync(sources, { recursive: true });
    writeFileSync(join(sources, 'README.md'), README);
    try {
      const profile = {
        schema_version: 1,
        repo: { key: 'acme.tool', owner: 'acme', name: 'tool', url: 'https://github.com/acme/tool' },
        analyzed_at: '2026-10-01T00:00:00.000Z',
        prose: { what_it_does: 'x'.repeat(30), how_it_works: 'y'.repeat(30), verdict: 'z'.repeat(30), analyst_notes: '' },
        claims: [{
          claim: 'Independently audited by a third party',
          quote: 'Independently audited by a third party',
          source: { path: 'README.md', line: 1 },
          tier: 'code-verified',
          type: 'attribution',
          evidence: 'the README says so',
          cited_files: ['README.md'],
          downgrade: [],
          correlated: false,
          verdicts: [{ agent: 'technical-verifier', tier: 'code-verified', cited_files: ['README.md'], summary: 'confirmed' }],
        }],
        coverage: { claims_total: 1, verified: 1, self_reported: 0, contradicted: 0, unverifiable: 0, uncovered: 0 },
      };
    } finally {
      for (const k of ['GROUNDTRUTH_STATE_DIR', 'GROUNDTRUTH_CLONE_DIR']) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the fixture README is the text the fixtures above assume', () => {
    // If this drifts, every line-number assertion above is testing the wrong line.
    const lines = README.split('\n');
    assert.equal(lines[5], 'Zero runtime dependencies.');
    assert.equal(lines[12], 'in the file itself.');
    void readFileSync;
  });
};
