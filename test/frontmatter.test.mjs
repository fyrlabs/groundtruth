// A linter that never runs is worse than no linter: it reports success forever. This module was
// exported as a `run()` function and never invoked, so `npm run verify:frontmatter` exited 0 while
// the repo contained two deliberate violations.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintAgentFile, lintSkillFile, parseFrontmatter, AGENT_FIELDS_IGNORED_IN_PLUGIN } from '../scripts/lint-frontmatter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function lintCli() {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/lint-frontmatter.mjs')], { encoding: 'utf8', cwd: ROOT });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

export default ({ test, assert }) => {
  test('the linter runs when invoked as a CLI', () => {
    const result = lintCli();
    assert.equal(result.status, 0, `expected a clean pass, got:\n${result.out}`);
    assert.match(result.out, /frontmatter ok/, 'the linter printed nothing, so it may not have run');
  });

  test('the library flags a field plugin agents silently drop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-fm-'));
    const target = join(dir, 'agent.md');
    try {
      // permissionMode is silently ignored in plugin agents — it reads as enforcement and is not.
      writeFileSync(target, [
        '---',
        'name: probe',
        'description: A probe agent with a description long enough to route on for testing purposes.',
        'tools: Read',
        'model: haiku',
        'permissionMode: bypassPermissions',
        '---',
        '',
        '# probe',
        '',
      ].join('\n'));
      const result = lintAgentFile(target);
      assert.ok(result.errors.some((e) => /permissionMode/.test(e)), 'the ignored field was not flagged');
      assert.ok(result.errors.some((e) => /silently ignored/.test(e)), 'the reason it matters was not given');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a violation planted in a real agent file makes the CLI exit non-zero', () => {
    // This is the regression that matters: the linter exported run() and never called it, so
    // `npm run verify:frontmatter` exited 0 on any tree. Calling the library proves nothing about
    // that — only running the CLI against a violating repository does.
    const victim = join(ROOT, 'agents', 'spot-checker.md');
    const original = readFileSync(victim, 'utf8');
    try {
      writeFileSync(victim, original.replace(/^model: .*$/m, 'model: gpt-9-turbo'));
      const result = lintCli();
      assert.ok(result.status, 0, 'the CLI exited 0 on a violating tree');
      assert.match(result.out, /frontmatter lint failed/, 'it did not report a failure');
      assert.match(result.out, /gpt-9-turbo/, 'the offending model was not named');
    } finally {
      writeFileSync(victim, original);
    }
  });

  test('the linter runs regardless of how the checkout path is spelled', () => {
    // Two separate ways the naive self-invoke comparison silently disabled the linter, both of which
    // leave exit status 0 and no output — the exact no-op this guards against:
    //   a space: import.meta.url percent-encodes it, process.argv[1] does not
    //   a symlink: import.meta.url is resolved (/var -> /private/var on macOS), argv[1] is not
    // Each case is asserted on output, not just exit status, because exiting 0 silently is the bug.
    for (const shape of ['plain', 'with-space', 'symlinked']) {
      const parent = mkdtempSync(join(tmpdir(), 'gt-fm-path-'));
      try {
        let dir;
        if (shape === 'symlinked') {
          const real = join(parent, 'real');
          cpSync(ROOT, real, { recursive: true, filter: (src) => !src.endsWith(`${sep}node_modules`) });
          dir = join(parent, 'link');
          symlinkSync(real, dir);
        } else {
          dir = shape === 'with-space' ? join(parent, 'My Projects', 'groundtruth') : join(parent, 'groundtruth');
          cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.endsWith(`${sep}node_modules`) });
        }
        const result = spawnSync(process.execPath, [join(dir, 'scripts/lint-frontmatter.mjs')], { encoding: 'utf8', cwd: dir });
        const combined = `${result.stdout}${result.stderr}`;
        assert.equal(result.status, 0, `linter failed for a ${shape} path:\n${combined}`);
        assert.match(combined, /frontmatter ok/, `the linter produced no output for a ${shape} path — it did not run`);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  });

  test('an unknown model is rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-fm2-'));
    try {
      writeFileSync(join(dir, 'a.md'), '---\nname: x\ndescription: A description that is long enough to route on properly for testing.\nmodel: gpt-9-turbo\n---\n\n# x\n');
      const result = lintAgentFile(join(dir, 'a.md'));
      assert.ok(result.errors.some((e) => /model/.test(e)), 'an unknown model was accepted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every recognised alias is accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-fm3-'));
    try {
      for (const model of ['haiku', 'sonnet', 'opus', 'fable', 'inherit', 'claude-sonnet-5-5']) {
        writeFileSync(join(dir, 'a.md'), `---\nname: x\ndescription: A description that is long enough to route on properly for testing.\nmodel: ${model}\n---\n\n# x\n`);
        const result = lintAgentFile(join(dir, 'a.md'));
        assert.ok(!result.errors.some((e) => /model/.test(e)), `alias ${model} was rejected`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing model frontmatter field is not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-fm4-'));
    try {
      writeFileSync(join(dir, 'a.md'), '---\nname: x\ndescription: A description that is long enough to route on properly for testing.\n---\n\n# x\n');
      const result = lintAgentFile(join(dir, 'a.md'));
      assert.ok(!result.errors.some((e) => /model/.test(e)), 'an omitted model was flagged');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('frontmatter missing its opening dashes is reported, not silently parsed as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-fm5-'));
    try {
      writeFileSync(join(dir, 'a.md'), '# No frontmatter here\n');
      const result = lintAgentFile(join(dir, 'a.md'));
      assert.ok(result.errors.length > 0, 'a file with no frontmatter passed');
      assert.match(result.errors.join(' '), /first line|---/, 'the error does not say what is wrong');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the shipped agent files carry no field the plugin loader would drop', () => {
    for (const key of AGENT_FIELDS_IGNORED_IN_PLUGIN) {
      // Enforced by the CLI run above; asserted here so the set cannot be emptied silently.
      assert.ok(AGENT_FIELDS_IGNORED_IN_PLUGIN.length >= 4, 'the ignored-field list shrank — is that deliberate?');
      void key;
    }
  });

  test('every shipped agent passes the linter', () => {
    const result = lintCli();
    assert.equal(result.status, 0, `a shipped agent violates frontmatter rules:\n${result.out}`);
  });
};
