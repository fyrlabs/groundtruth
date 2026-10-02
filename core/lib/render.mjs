// Report renderer. The single writer of output/groundtruth-report.md.
//
// The report is generated from profile.json files, never appended to by a model. That is what
// makes concurrent runs safe (no two writers), re-renders byte-identical (idempotent), and
// recovery from an interrupted run possible (render again from state).
//
// Prose comes from the profile's `prose` block verbatim. The renderer cannot invent judgment, so
// a missing field fails validation upstream rather than producing a bland sentence here.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths, reportPath, repoParts, repoStateDir } from './paths.mjs';
import { readJson } from './state.mjs';
import { validateProfile } from './validate.mjs';

const MARKER_START = '<!-- groundtruth:profile:<key> -->';
const MARKER_END = '<!-- /groundtruth:profile:<key> -->';

const TIER_ICON = {
  'code-verified': '✅',
  'self-reported': '⚠️',
  contradicted: '❌',
  unverifiable: '🔍',
};

const LEVEL_LABEL = {
  full: 'Full',
  partial: 'Partial',
  'instructions-only': 'Instructions only',
  none: 'None',
};

// Repo-controlled strings reach the report, and the report is designed to be dropped into a project
// where a future agent will read it. Strip control and bidi characters so a repo cannot hide text
// from a human reviewer, flatten newlines so a claim cannot forge table rows, and escape pipes.
const HIDDEN = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function groupDigits(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function clean(text) {
  return String(text ?? '').replace(HIDDEN, '');
}

function esc(text) {
  return clean(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function mdCell(text) {
  return esc(text).slice(0, 300) || '—';
}

function renderProfile(profile) {
  const { repo, health = {}, license = {} } = profile;
  const out = [];
  const title = `${repo.owner}/${repo.name}`;

  out.push(`${MARKER_START.replace('<key>', repo.key)}`);
  out.push(`### [${title}](${repo.url})`);
  out.push('');

  const status = health.status ? `**${esc(health.status)}**${health.replaced_by ? ` — replaced by \`${esc(health.replaced_by)}\`` : ''}` : '—';
  const ref = repo.ref ? ` @ \`${esc(repo.ref)}\`` : '';
  const sha = repo.sha ? ` (\`${esc(repo.sha.slice(0, 12))}\`)` : '';
  out.push(`${status} · analyzed ${esc(profile.analyzed_at?.slice(0, 10))}${ref}${sha} · license **${esc(license.actual || 'unknown')}** ${TIER_ICON[license.tier] || ''}`);
  // Grouped digits via a fixed locale: toLocaleString() without a locale varies with the host's
  // settings, which is one way a "deterministic" renderer stops being byte-identical.
  if (health.stars != null) out.push(`Stars: ${groupDigits(health.stars)} (observed ${esc(health.stars_observed_at || 'unknown')})`);
  out.push('');

  out.push(`#### What it does`);
  out.push('');
  out.push(clean(profile.prose.what_it_does));
  out.push('');

  out.push(`#### How it works`);
  out.push('');
  out.push(clean(profile.prose.how_it_works));
  out.push('');

  if (profile.tech_stack?.length) {
    out.push('#### Tech stack');
    out.push('');
    out.push('| Component | Detail | Evidence |');
    out.push('|---|---|---|');
    for (const row of profile.tech_stack) {
      out.push(`| ${mdCell(row.component)} | ${mdCell(row.detail)} | ${TIER_ICON[row.tier] || ''} ${row.tier} |`);
    }
    out.push('');
  }

  out.push('#### Claim verification');
  out.push('');
  if (!profile.claims?.length) {
    out.push('_No verifiable claims were extracted from this repo._');
  } else {
    out.push('| Claim | Tier | Evidence | Notes |');
    out.push('|---|---|---|---|');
    for (const c of profile.claims) {
      const notes = [];
      if (c.correlated) notes.push('correlated — same source cited by all agents');
      if (c.downgrade?.length) notes.push(c.downgrade.join(', '));
      if (c.cited_files?.length) notes.push(`\`${esc(c.cited_files[0])}\``);
      out.push(`| ${mdCell(c.claim)} | ${TIER_ICON[c.tier]} ${c.tier} | ${mdCell(c.evidence)} | ${esc(notes.join(' · ')) || '—'} |`);
    }
  }
  out.push('');

  if (profile.platform_support?.length) {
    out.push('#### Platform support');
    out.push('');
    out.push('| Platform | Claimed | Level | Evidence |');
    out.push('|---|---|---|---|');
    for (const p of profile.platform_support) {
      out.push(`| ${mdCell(p.platform)} | ${p.claimed ? 'yes' : 'no'} | ${LEVEL_LABEL[p.level] || p.level} ${TIER_ICON[p.tier] || ''} | ${mdCell(p.evidence)} |`);
    }
    out.push('');
  }

  if (profile.conflicts?.length) {
    out.push('#### Conflicts with other profiled tools');
    out.push('');
    for (const c of profile.conflicts) {
      out.push(`- **${mdCell(c.other_repo)}** — ${esc(c.type)}, severity **${c.severity}**: ${esc(c.detail)}`);
    }
    out.push('');
  }

  const cov = profile.coverage || {};
  out.push('#### Coverage');
  out.push('');
  out.push(`${cov.claims_total ?? 0} claims · ${cov.verified ?? 0} code-verified · ${cov.self_reported ?? 0} self-reported · ${cov.contradicted ?? 0} contradicted · ${cov.unverifiable ?? 0} unverifiable · **${cov.uncovered ?? 0} uncovered**`);
  if (cov.uncovered_notes?.length) {
    out.push('');
    for (const n of cov.uncovered_notes) out.push(`- ${esc(n)}`);
  }
  out.push('');

  out.push('#### Verdict');
  out.push('');
  out.push(clean(profile.prose.verdict));
  out.push('');

  if (profile.prose.analyst_notes) {
    out.push('#### Analyst notes');
    out.push('');
    out.push(clean(profile.prose.analyst_notes));
    out.push('');
  }

  if (profile.injections_detected?.length) {
    out.push('#### Injection attempts observed');
    out.push('');
    out.push('This repository contained content shaped like agent instructions or pipeline output. It was quarantined and its claims could not earn a `code-verified` tier.');
    out.push('');
    for (const d of profile.injections_detected.slice(0, 10)) {
      out.push(`- \`${mdCell(d.file)}\` — ${esc(d.kind)}`);
    }
    out.push('');
  }

  out.push(MARKER_END.replace('<key>', repo.key));
  return out.join('\n');
}

// The clock is a parameter so a render is a pure function of (state, now). A test can then assert
// byte-identical output across two dates, which is the actual claim — the earlier version stamped
// new Date() inside the renderer, so the report header and the provenance file were never stable and
// the test that "proved" purity exercised only the one function with no timestamp in it.
function reportHeader(state, profiles, generated) {
  const counts = { verified: 0, contradicted: 0, uncovered: 0 };
  for (const p of profiles) {
    counts.verified += p.coverage?.verified ?? 0;
    counts.contradicted += p.coverage?.contradicted ?? 0;
    counts.uncovered += p.coverage?.uncovered ?? 0;
  }
  return [
    '# Groundtruth research report',
    '',
    '> Generated from verified pipeline state. Do not edit by hand — edit `profile.json` and re-render.',
    '> Every claim carries an evidence tier. Claims nobody could adjudicate are counted, not dropped.',
    '',
    `**Generated**: ${generated}`,
    `**Pipeline run**: ${esc(state.run_id || '—')}`,
    `**Repos profiled**: ${profiles.length}`,
    `**Claims**: ${counts.verified} code-verified · ${counts.contradicted} contradicted · ${counts.uncovered} uncovered`,
    '',
    '---',
    '',
    '## Confidence tiers',
    '',
    '| Tier | Meaning |',
    '|---|---|',
    '| ✅ `code-verified` | Confirmed by reading implementation code, manifests, or tests in this repo |',
    '| ⚠️ `self-reported` | Documented but not independently confirmed; code neither confirms nor denies |',
    '| ❌ `contradicted` | Directly contradicted by code or an authoritative external source |',
    '| 🔍 `unverifiable` | Needs live execution, credentials, or data unavailable at analysis time |',
    '',
    'A `code-verified` tier means at least one agent cited a file it actually read. When every agent',
    'cited the *same* file, the claim is marked `correlated` and the agreement carries no independent',
    'weight — three agents reading the same source are one opinion, not three.',
    '',
    '---',
    '',
    '## Contents',
    '',
    ...(profiles.length
      ? profiles.map((p) => `- [${esc(p.repo.owner)}/${esc(p.repo.name)}](#${p.repo.key.replace(/[^\w-]/g, '')})`)
      : ['_No repos profiled yet._']),
    '',
    '---',
    '',
    '## Repo profiles',
    '',
  ].join('\n');
}

// The comparison and summary come from run.json, which scripts/synthesize.mjs computes from state
// with no model involved. Deriving them here instead would duplicate that logic and reintroduce a
// second writer over the report's cross-repo sections.
function renderComparison(synthesis) {
  const rows = synthesis?.repos || [];
  const watchlist = synthesis?.watchlist || [];

  const lines = [
    '## Executive summary',
    '',
    synthesis?.executive_summary || '_Not synthesized yet — run `node scripts/synthesize.mjs`._',
    '',
    '---',
    '',
    '## Comparative analysis',
    '',
  ];

  if (!rows.length) {
    lines.push('_No repositories profiled yet._', '');
  } else {
    lines.push(
      '| Repo | Status | License | OSS | Claims | Verified | Contradicted | Uncovered |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const r of rows) {
      lines.push(`| ${mdCell(r.name)} | ${mdCell(r.status)} | ${mdCell(r.license)} | ${mdCell(r.oss_compatible)} | ${r.claims} | ${r.verified} (${r.verification_rate}%) | ${r.contradicted} | ${r.uncovered} |`);
    }
    lines.push(
      '',
      'Verification rate is claims-verified ÷ claims-extracted. A low rate is not a defect in the repo —',
      'it usually means the project documents less than it implies, or its claims need live execution.',
      '',
    );
  }

  if (watchlist.length) {
    lines.push('## Watch list', '', 'Promising, not yet ready. Re-checked on every run.', '', '| Repo | Why waiting | Check again |', '|---|---|---|');
    for (const w of watchlist) {
      lines.push(`| ${mdCell(w.url)} | ${mdCell(w.reason)} | ${mdCell(w.check_again)} |`);
    }
    lines.push('');
  }

  const dead = rows.filter((r) => /deprecated|archived|replaced|abandoned/.test(r.status));
  if (dead.length) {
    lines.push('## Deprecated or unmaintained', '');
    for (const r of dead) lines.push(`- **${mdCell(r.name)}** — ${mdCell(r.status)}. ${mdCell(r.summary)}`);
    lines.push('');
  }

  return lines.join('\n');
}

function renderMethodology(profiles) {
  const totalInjections = profiles.reduce((n, p) => n + (p.injections_detected?.length || 0), 0);
  return [
    '## Methodology',
    '',
    'Each repo is cloned shallow into an isolated directory outside any project tree, then read by',
    'specialised agents with deliberately non-overlapping evidence surfaces — one reads manifests,',
    'source and tests; one reads licensing and git metadata; one reads installers and adapters. The',
    'surfaces do not overlap because agents that share inputs fail together, and their agreement',
    'would otherwise be reported as independent confirmation.',
    '',
    'Cloned repositories are treated as untrusted input. Repos carrying harness control files are',
    'quarantined outright, content matching injection patterns is scrubbed before an agent sees it,',
    'and every verdict must cite a file that agent actually read during that run.',
    '',
    'What this cannot do: reproduce the benchmarks a project claims about itself, see private data,',
    'or prevent a malicious repository from influencing the *reader* of this report. Stars and commit',
    'dates are point-in-time observations.',
    '',
    totalInjections
      ? `**${totalInjections} injection attempt(s) were observed and quarantined during this run.**`
      : 'No injection attempts were observed in this run.',
    '',
  ].join('\n');
}

export function listProfiles() {
  const dir = paths.reposDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const key of readdirSync(dir)) {
    const profile = readJson(join(dir, key, 'profile.json'), null);
    if (profile) out.push(profile);
  }
  // Plain codepoint comparison, not localeCompare: sorting must not depend on the host locale.
  return out.sort((a, b) => (a.repo.key < b.repo.key ? -1 : a.repo.key > b.repo.key ? 1 : 0));
}

export function renderReport({ keys = null, now = new Date() } = {}) {
  const state = readJson(join(paths.runsDir(), 'active', 'state.json'), { run_id: null });
  const synthesis = readJson(join(paths.stateRoot(), 'run.json'), null);
  let profiles = listProfiles();
  if (keys?.length) profiles = profiles.filter((p) => keys.includes(p.repo.key));

  const invalid = profiles
    .map((p) => ({ key: p.repo.key, result: validateProfile(p, { key: p.repo.key, enforceReads: false }) }))
    .filter((r) => !r.result.ok);
  if (invalid.length) {
    for (const { key, result } of invalid) {
      for (const e of result.errors) process.stderr.write(`profile ${key}: ${e}\n`);
    }
    throw new Error(`refusing to render: ${invalid.length} profile(s) failed validation`);
  }

  const body = [
    reportHeader(state, profiles, now.toISOString().slice(0, 10)),
    ...profiles.map((p) => `${renderProfile(p)}\n\n---\n\n`),
    renderComparison(synthesis),
    renderMethodology(profiles),
    '---',
    '',
    '## Provenance',
    '',
    'This report is rendered from `profile.json` files. The machine-readable provenance record —',
    'every claim, its cited files, the agents that adjudicated it, and the model each ran on —',
    'lives in `report.provenance.json` alongside this file.',
    '',
  ].join('\n');

  mkdirSync(paths.outputDir(), { recursive: true });
  writeFileSync(reportPath(), body, 'utf8');
  writeFileSync(join(paths.outputDir(), 'report.provenance.json'), `${JSON.stringify(buildProvenance(profiles, now), null, 2)}\n`, 'utf8');
  writeFileSync(join(paths.outputDir(), 'llms.txt'), buildLlmsTxt(profiles), 'utf8');
  return { path: reportPath(), repos: profiles.length };
}

// W3C PROV-O shaped, so a reader can mechanically audit every tier rather than trusting a symbol.
export function buildProvenance(profiles, now = new Date()) {
  return {
    schema: 'groundtruth/provenance/1',
    generated_at: now.toISOString(),
    entities: profiles.flatMap((p) => p.claims.map((c, i) => ({
      id: `${p.repo.key}/claim/${i}`,
      type: 'Claim',
      text: c.claim,
      tier: c.tier,
      downgrade: c.downgrade || [],
      correlated: !!c.correlated,
    }))),
    activities: profiles.flatMap((p) => p.claims.flatMap((c, i) => (c.verdicts || []).map((v) => ({
      id: `${p.repo.key}/claim/${i}/verify/${v.agent}`,
      type: 'Verification',
      used: (v.cited_files || []).map((f) => `${p.repo.key}/file/${f}`),
      wasAssociatedWith: { agent: v.agent, tier: v.tier, summary: v.summary || '' },
    })))),
    agents: [...new Set(profiles.flatMap((p) => p.claims.flatMap((c) => (c.verdicts || []).map((v) => v.agent))))].map((name) => ({ id: name, type: 'Agent' })),
  invalidated: profiles.flatMap((p) => p.claims.map((c, i) => c.tier === 'contradicted'
    ? { id: `${p.repo.key}/claim/${i}`, type: 'Invalidation', reason: c.evidence }
    : null).filter(Boolean)),
    entities_note: 'File entities are addressed as <repo>/file/<clone-relative path>; resolve against the recorded commit SHA.',
    wasRevisionOf: profiles.map((p) => ({
      subject: p.repo.key,
      object: `${p.repo.key}@${p.repo.sha || 'unknown'}`,
    })),
  };
}

function buildLlmsTxt(profiles) {
  const lines = [
    '# Groundtruth research report',
    '',
    '> Code-grounded profiles of GitHub repositories. Every claim carries an evidence tier and a file citation.',
    '',
  ];
  for (const p of profiles) {
    const cov = p.coverage || {};
    lines.push(`## ${p.repo.owner}/${p.repo.name}`, '', `- url: ${p.repo.url}`);
    lines.push(`- license: ${p.license?.actual || 'unknown'}`);
    lines.push(`- status: ${p.health?.status || 'unknown'}`);
    lines.push(`- claims: ${cov.claims_total ?? 0} (${cov.verified ?? 0} verified, ${cov.uncovered ?? 0} uncovered)`);
    lines.push(`- summary: ${esc(p.prose.what_it_does)}`, '');
  }
  lines.push('## Provenance', '', '- machine-readable: report.provenance.json', '- tiers: code-verified | self-reported | contradicted | unverifiable', '');
  return lines.join('\n');
}

export { renderProfile, reportPath, buildLlmsTxt };