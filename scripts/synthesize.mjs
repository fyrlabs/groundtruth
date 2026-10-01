#!/usr/bin/env node
// Render the cross-repo synthesis the report needs but a per-repo renderer cannot.
//
// Exec summary, comparison table, and the watch list depend on every profile at once, so they are
// computed here from state and written as run.json. The renderer then composes them. This replaces
// the old design's second orchestrator invocation, which read and rewrote the whole report file —
// two writers over one file is exactly the corruption the single-writer renderer exists to prevent.
//
// Everything here is deterministic given the profiles: no model is involved, so a re-run produces
// identical output and there is nothing to hallucinate.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../core/lib/paths.mjs';
import { listProfiles } from '../core/lib/render.mjs';
import { readJson, writeJson } from '../core/lib/state.mjs';

function tierLabel(status) {
  return {
    active: 'active',
    'low-activity': 'low activity',
    'potentially-abandoned': 'possibly abandoned',
    archived: 'archived',
    deprecated: 'deprecated',
    replaced: 'replaced',
  }[status] || 'unknown';
}

function watchlist() {
  const file = join(paths.stateRoot(), 'watchlist.json');
  const rows = existsSync(file) ? readJson(file, { entries: [] }).entries || [] : [];
  return rows.filter((r) => r.status !== 'dropped' && r.status !== 'promoted').map((r) => ({
    url: r.url,
    reason: r.reason,
    promotion_signal: r.promotion_signal,
    check_again: r.check_again,
  }));
}

export function synthesize(profiles) {
  const state = readJson(join(paths.runsDir(), 'active', 'state.json'), {});
  const repos = profiles.map((p) => {
    const cov = p.coverage || {};
    const total = cov.claims_total ?? 0;
    return {
      key: p.repo.key,
      name: `${p.repo.owner}/${p.repo.name}`,
      url: p.repo.url,
      status: tierLabel(p.health?.status),
      license: p.license?.actual || 'unknown',
      oss_compatible: p.license?.oss_compatible || 'unknown',
      summary: p.prose?.what_it_does || '',
      verdict: p.prose?.verdict || '',
      claims: total,
      verified: cov.verified ?? 0,
      self_reported: cov.self_reported ?? 0,
      contradicted: cov.contradicted ?? 0,
      unverifiable: cov.unverifiable ?? 0,
      uncovered: cov.uncovered ?? 0,
      verification_rate: total ? Math.round(((cov.verified ?? 0) / total) * 100) : 0,
      injections: p.injections_detected?.length || 0,
    };
  });

  const totals = repos.reduce((acc, r) => ({
    claims: acc.claims + r.claims,
    verified: acc.verified + r.verified,
    contradicted: acc.contradicted + r.contradicted,
    uncovered: acc.uncovered + r.uncovered,
    injections: acc.injections + r.injections,
  }), { claims: 0, verified: 0, contradicted: 0, uncovered: 0, injections: 0 });

  // Ranked by how much of what the project says about itself survived checking. A low rate is not
  // necessarily bad news: it usually means the project documents less than it implies.
  const ranked = [...repos].sort((a, b) => b.verification_rate - a.verification_rate || a.claims - b.claims);

  const strongest = ranked.filter((r) => r.verification_rate >= 60).slice(0, 3);
  const weakest = [...repos].filter((r) => r.verification_rate < 30).reverse().slice(0, 3);
  const deprecated = repos.filter((r) => /deprecated|archived|replaced|abandoned/.test(r.status));

  const lines = [];
  if (!repos.length) {
    lines.push('No repositories have been profiled in this run yet.');
  } else {
    lines.push(
      `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'} profiled. ` +
      `Of ${totals.claims} specific claims the projects made about themselves, ${totals.verified} ` +
      `were confirmed against implementation code, ${totals.contradicted} were contradicted, and ` +
      `${totals.uncovered} could not be adjudicated by any verifier.`,
    );
    if (strongest.length) {
      lines.push('', 'Most of what these projects claim held up:');
      for (const r of strongest) lines.push(`- **${r.name}** — ${r.verification_rate}% of its claims verified (${r.verified}/${r.claims}).`);
    }
    if (weakest.length) {
      lines.push('', 'Where documentation and implementation disagree most:');
      for (const r of weakest) lines.push(`- **${r.name}** — only ${r.verification_rate}% verified, with ${r.uncovered} claims no verifier could reach.`);
    }
    if (deprecated.length) {
      lines.push('', 'Before adopting any of these, note:');
      for (const r of deprecated) lines.push(`- **${r.name}** is ${r.status}.`);
    }
    if (totals.injections) {
      lines.push('', `${totals.injections} prompt-injection attempt(s) were detected in the analysed repositories. ` +
        'They are disclosed per repo under "Injection attempts observed" and are why an injected repo ' +
        'cannot earn a code-verified tier.');
    }
  }

  return {
    schema_version: 1,
    run_id: state.run_id || null,
    generated_at: new Date().toISOString(),
    models: state.models || null,
    repos,
    totals,
    executive_summary: lines.join('\n'),
    watchlist: watchlist(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const profiles = listProfiles();
  const result = synthesize(profiles);
  mkdirSync(paths.stateRoot(), { recursive: true });
  writeJson(join(paths.stateRoot(), 'run.json'), result);
  process.stdout.write(`synthesized ${result.repos.length} profile(s) into run.json\n`);
  process.stdout.write(`\n${result.executive_summary}\n`);
}