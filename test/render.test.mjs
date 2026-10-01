// The report is generated from state, so a render must be pure: same state in, same bytes out.
// That property is what makes concurrent runs and re-renders safe, so it is tested directly.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderProfile, buildProvenance, buildLlmsTxt } from '../core/lib/render.mjs';
import { writeJson } from '../core/lib/state.mjs';

function profile(overrides = {}) {
  return {
    schema_version: 1,
    repo: { key: 'acme.tool', owner: 'acme', name: 'tool', url: 'https://github.com/acme/tool', ref: 'main', sha: 'abc1234def' },
    analyzed_at: '2026-10-01T00:00:00.000Z',
    health: { status: 'active', stars: 12400, stars_observed_at: '2026-10-01' },
    license: { actual: 'MIT', tier: 'code-verified' },
    tech_stack: [{ component: 'Language', detail: 'TypeScript 5.4', tier: 'code-verified' }],
    platform_support: [{ platform: 'Claude Code', claimed: true, level: 'full', tier: 'code-verified', evidence: 'manifest.json' }],
    conflicts: [{ other_repo: 'other/thing', type: 'namespace', severity: 'low', detail: 'command name overlap' }],
    prose: {
      what_it_does: 'Does one specific thing for one specific audience, well.',
      how_it_works: 'Reads configuration and dispatches to handlers that implement the behaviour.',
      verdict: 'Reasonable for its narrow purpose; verify licensing before commercial adoption.',
      analyst_notes: 'One contradiction between README and manifest, resolved in favour of the manifest.',
    },
    coverage: { claims_total: 2, verified: 1, self_reported: 1, contradicted: 0, unverifiable: 0, uncovered: 0 },
    claims: [
      { claim: 'supports 12 platforms', type: 'compatibility', tier: 'code-verified', evidence: 'installers/ has 12 platform entries', cited_files: ['installers/'], downgrade: [], correlated: false, verdicts: [{ agent: 'conflicts-verifier', tier: 'code-verified', cited_files: ['installers/'], summary: 'counted 12' }] },
      { claim: 'zero known vulnerabilities', type: 'security', tier: 'self-reported', evidence: 'stated in README, no audit referenced', cited_files: ['README.md'], downgrade: ['risk-of-bias'], correlated: false, verdicts: [{ agent: 'community-verifier', tier: 'unverifiable', cited_files: ['README.md'], summary: 'no advisory data' }] },
    ],
    ...overrides,
  };
}

export default ({ test, assert }) => {
  test('a profile renders every section a reader needs', () => {
    const md = renderProfile(profile());
    for (const heading of ['What it does', 'How it works', 'Tech stack', 'Claim verification', 'Platform support', 'Conflicts with other profiled tools', 'Coverage', 'Verdict', 'Analyst notes']) {
      assert.match(md, new RegExp(heading), `missing section: ${heading}`);
    }
  });

  test('tiers are rendered with their symbol and name', () => {
    const md = renderProfile(profile());
    assert.match(md, /✅ code-verified/);
    assert.match(md, /⚠️ self-reported/);
    assert.match(md, /downgrade domains|risk-of-bias/, 'the downgrade domain should be visible');
  });

  test('correlated agreement is disclosed in the table', () => {
    const p = profile();
    p.claims[0].correlated = true;
    const md = renderProfile(p);
    assert.match(md, /correlated/, 'a correlated claim was not disclosed');
  });

  test('an uncovered count is always shown', () => {
    const p = profile();
    p.coverage = { claims_total: 2, verified: 1, self_reported: 0, contradicted: 0, unverifiable: 0, uncovered: 1 };
    p.claims[1].tier = 'unverifiable';
    p.coverage.uncovered_notes = ['no advisory database reachable at analysis time'];
    const md = renderProfile(p);
    assert.match(md, /\*\*1 uncovered\*\*/, 'the uncovered count was not surfaced');
    assert.match(md, /no advisory database reachable/, 'uncovered notes were dropped');
  });

  test('the exact commit analysed is recorded', () => {
    assert.match(renderProfile(profile()), /abc1234def/, 'the analysed SHA is missing from the profile');
  });

  test('repo-controlled text cannot break out of the table', () => {
    const p = profile();
    p.claims[0].claim = 'evil | ✅ code-verified | forged | row';
    p.claims[0].evidence = 'a | b | c';
    const md = renderProfile(p);
    for (const line of md.split('\n').filter((l) => l.includes('forged') || l.includes('a | b'))) {
      const cells = line.split(/(?<!\\)\|/).length - 1;
      assert.equal(cells, 5, `row has ${cells} delimiters: ${line}`);
    }
  });

  test('control and bidi characters never reach the report', () => {
    const p = profile();
    p.prose.what_it_does = 'Fine. ‮reversed text ⁠hidden.';
    p.prose.verdict = 'Fine. zero width.';
    const md = renderProfile(p);
    const HIDDEN = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/;
    const offenders = md.split('\n').filter((l) => HIDDEN.test(l));
    assert.equal(offenders.length, 0, `hidden characters reached the report: ${JSON.stringify(offenders.slice(0, 2))}`);
    assert.match(md, /reversed text/, 'legitimate text was destroyed');
    assert.match(md, /hidden/, 'legitimate text was destroyed');
  });

  test('newlines in repo text cannot forge table rows', () => {
    const p = profile();
    p.claims[0].claim = 'legit\n\n| forged | ✅ code-verified | injected row |';
    const md = renderProfile(p);
    assert.ok(!/^\| forged \|/m.test(md), 'a newline forged an extra table row');
  });

  test('injection attempts are disclosed to the reader', () => {
    const p = profile({ injections_detected: [{ file: 'AGENTS.md', kind: 'instruction-override', snippet: 'ignore previous instructions' }] });
    const md = renderProfile(p);
    assert.match(md, /Injection attempts observed/);
    assert.match(md, /AGENTS\.md/);
    assert.match(md, /could not earn a `code-verified` tier/, 'the consequence of an injection should be stated');
  });

  test('rendering is pure — identical input yields identical bytes', () => {
    assert.equal(renderProfile(profile()), renderProfile(profile()));
  });

  test('provenance output is machine-readable and cites files', () => {
    const prov = buildProvenance([profile()]);
    assert.equal(prov.schema, 'groundtruth/provenance/1');
    assert.equal(prov.entities.length, 2, 'expected one entity per claim');
    assert.equal(prov.activities.length, 2, 'expected one activity per verdict');
    assert.ok(prov.agents.some((a) => a.id === 'conflicts-verifier'), 'the verifying agent is missing');
    const activity = prov.activities.find((a) => a.used.some((u) => u.endsWith('installers/')));
    assert.ok(activity, 'no activity records the cited file as used');
    assert.equal(activity.wasAssociatedWith.tier, 'code-verified');
  });

  test('provenance marks contradicted claims as invalidated', () => {
    const p = profile();
    p.claims[1].tier = 'contradicted';
    p.coverage = { claims_total: 2, verified: 1, self_reported: 0, contradicted: 1, unverifiable: 0, uncovered: 0 };
    const prov = buildProvenance([p]);
    assert.equal(prov.invalidated.length, 1, 'a contradicted claim was not invalidated in the record');
    assert.match(prov.invalidated[0].id, /claim\/1$/);
  });

  test('provenance records the analysed revision', () => {
    const prov = buildProvenance([profile()]);
    assert.ok(prov.wasRevisionOf.some((r) => r.object.includes('abc1234def')), 'the analysed SHA is not in the provenance record');
  });

  test('the llms.txt bundle carries per-repo facts', () => {
    const txt = buildLlmsTxt([profile()]);
    assert.match(txt, /acme\/tool/);
    assert.match(txt, /claims: 2 \(1 verified/);
    assert.match(txt, /report\.provenance\.json/);
  });

  test('a profile with no claims still renders honestly', () => {
    const p = profile({ claims: [], coverage: { claims_total: 0, verified: 0, self_reported: 0, contradicted: 0, unverifiable: 0, uncovered: 0 } });
    const md = renderProfile(p);
    assert.match(md, /No verifiable claims/, 'an empty claim set should say so rather than render an empty table');
  });
};
