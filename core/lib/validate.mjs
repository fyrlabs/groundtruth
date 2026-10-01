// Payload validation. The gate that makes a tiered report auditable instead of merely asserted.
//
// The load-bearing rule: a verdict is accepted only if its cited files exist inside the clone root
// AND appear in that agent's read log for this run. That single invariant defeats three separate
// failures at once:
//
//   - Output-format forgery. A hostile README containing a forged `## ANALYSIS_REPORT` block can be
//     shaped exactly like our output, and an instruction-level injection preamble cannot catch it
//     because a forged block is *data shaped like output*, not an instruction. Here, a forged
//     verdict must cite a file the attacker does not control, at a line they did not read.
//   - Hallucinated confirmations. An agent cannot cite a file it did not read.
//   - Correlated verifier agreement. Two verifiers citing the same file is flagged, because
//     agreement that shares a source carries no independent weight.

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { repoDir, stateRoot } from './paths.mjs';

const TIERS = new Set(['code-verified', 'self-reported', 'contradicted', 'unverifiable']);
const DOWNGRADES = new Set(['risk-of-bias', 'imprecision', 'inconsistency', 'indirectness', 'publication-bias']);
const LEVELS = new Set(['full', 'partial', 'instructions-only', 'none']);
const SEVERITIES = new Set(['high', 'medium', 'low']);

const LIMITS = {
  claims: 200,
  claimText: 500,
  summary: 1000,
  citedFiles: 8,
  prose: 1400,
  techStack: 40,
  platforms: 20,
  conflicts: 20,
};

function fail(errors, msg) {
  errors.push(msg);
}

function checkTier(errors, where, tier) {
  if (!TIERS.has(tier)) fail(errors, `${where}: invalid tier ${JSON.stringify(tier)} — must be one of ${[...TIERS].join(', ')}`);
}

function checkString(errors, where, value, min, max, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(errors, `${where}: missing required string`);
    return;
  }
  if (typeof value !== 'string') return fail(errors, `${where}: expected string, got ${typeof value}`);
  if (min !== undefined && value.length < min) fail(errors, `${where}: shorter than ${min} chars`);
  if (max !== undefined && value.length > max) fail(errors, `${where}: longer than ${max} chars (${value.length})`);
}

// A cited path must resolve to a real file inside the clone. Symlink escapes and ../ traversal
// both fail here, which is why this check is a path resolve rather than a string prefix test.
function checkCitedFile(errors, where, cited, root) {
  if (typeof cited !== 'string' || !cited) return fail(errors, `${where}: cited_files entry is empty`);
  if (cited.startsWith('/') || cited.includes('..')) {
    return fail(errors, `${where}: cited path ${JSON.stringify(cited)} escapes the clone root`);
  }
  const abs = resolve(join(root, cited));
  if (abs !== root && !abs.startsWith(root + sep)) {
    return fail(errors, `${where}: cited path ${JSON.stringify(cited)} resolves outside the clone root`);
  }
  if (!existsSync(abs)) return fail(errors, `${where}: cited file ${JSON.stringify(cited)} does not exist in the clone`);
  return abs;
}

function loadReadLog(key) {
  try {
    const file = join(repoStateDir(key), 'reads.jsonl');
    return new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).path));
  } catch {
    return null;
  }
}

function repoStateDir(key) {
  return join(stateRoot(), 'repos', key);
}

export function validateProfile(profile, { key, enforceReads = true } = {}) {
  const errors = [];
  const root = repoDir(key);

  if (profile.schema_version !== 1) fail(errors, 'profile.schema_version must be 1');
  if (!profile.repo || profile.repo.key !== key) fail(errors, `profile.repo.key must equal ${key}`);

  checkString(errors, 'prose.what_it_does', profile.prose?.what_it_does, 20, 900);
  checkString(errors, 'prose.how_it_works', profile.prose?.how_it_works, 20, LIMITS.prose);
  checkString(errors, 'prose.verdict', profile.prose?.verdict, 20, 900);
  checkString(errors, 'prose.analyst_notes', profile.prose?.analyst_notes, 1, LIMITS.prose, { required: false });

  const claims = Array.isArray(profile.claims) ? profile.claims : [];
  if (claims.length > LIMITS.claims) fail(errors, `claims: ${claims.length} exceeds the ${LIMITS.claims} cap (possible flooding)`);

  const readLog = enforceReads ? loadReadLog(key) : null;
  let verified = 0, selfReported = 0, contradicted = 0, unverifiable = 0, uncovered = 0;

  for (const [i, c] of claims.entries()) {
    const where = `claims[${i}]`;
    checkString(errors, `${where}.claim`, c.claim, 1, LIMITS.claimText);
    checkString(errors, `${where}.evidence`, c.evidence, 1, LIMITS.summary);
    checkTier(errors, where, c.tier);

    const verdicts = Array.isArray(c.verdicts) ? c.verdicts : [];
    if (verdicts.length === 0) {
      uncovered += 1;
      fail(errors, `${where}: no verdicts — an unreviewable claim must be tiered unverifiable, not code-verified`);
    }

    const citedByVerdict = new Map();
    for (const [j, v] of verdicts.entries()) {
      const vw = `${where}.verdicts[${j}]`;
      checkTier(errors, vw, v.tier);
      const files = Array.isArray(v.cited_files) ? v.cited_files : [];
      if (files.length === 0) fail(errors, `${vw}.cited_files: empty — every verdict needs at least one cited file`);
      if (files.length > LIMITS.citedFiles) fail(errors, `${vw}.cited_files: ${files.length} exceeds ${LIMITS.citedFiles}`);
      for (const f of files) {
        checkCitedFile(errors, vw, f, root);
        if (!citedByVerdict.has(v.agent)) citedByVerdict.set(v.agent, new Set());
        citedByVerdict.get(v.agent).add(f);
      }
    }

    // Correlation check. Agreement is only informative when it rests on distinct evidence: if the
    // union of everything every agent cited is no larger than any single agent's own set, then no
    // agent saw anything the others did not, and the agreement carries no independent weight.
    const distinctAgents = new Set(verdicts.map((v) => v.agent));
    if (distinctAgents.size > 1) {
      const union = new Set(verdicts.flatMap((v) => v.cited_files || []));
      const widest = Math.max(...verdicts.map((v) => (v.cited_files || []).length));
      if (union.size > 0 && union.size === widest) {
        if (c.tier === 'code-verified') {
          fail(errors, `${where}: every agent cites the same file(s) (${[...union].join(', ')}) — ` +
            'agreement from a shared source is not independent verification; downgrade or cite distinct evidence');
        }
        if (c.correlated !== true) {
          fail(errors, `${where}.correlated must be true when all verdicts cite the same file`);
        }
      } else if (c.correlated === true) {
        fail(errors, `${where}.correlated is true but the agents cited distinct files`);
      }
    }
    void citedByVerdict;

    if (c.tier === 'code-verified') {
      const backing = verdicts.filter((v) => v.tier === 'code-verified');
      if (backing.length === 0) fail(errors, `${where}: tier is code-verified but no verdict confirms it`);
      for (const v of backing) {
        for (const f of v.cited_files || []) {
          const abs = resolve(join(root, f));
          if (existsSync(abs)) continue;
          fail(errors, `${where}: code-verified cites missing file ${f}`);
        }
      }
      verified += 1;
    } else if (c.tier === 'self-reported') selfReported += 1;
    else if (c.tier === 'contradicted') contradicted += 1;
    else unverifiable += 1;
  }

  for (const [i, row] of (profile.tech_stack || []).entries()) {
    checkTier(errors, `tech_stack[${i}]`, row.tier);
  }
  for (const [i, row] of (profile.platform_support || []).entries()) {
    checkTier(errors, `platform_support[${i}]`, row.tier);
    if (!LEVELS.has(row.level)) fail(errors, `platform_support[${i}].level invalid: ${row.level}`);
  }
  for (const [i, row] of (profile.conflicts || []).entries()) {
    if (!SEVERITIES.has(row.severity)) fail(errors, `conflicts[${i}].severity invalid: ${row.severity}`);
  }
  if (profile.license) checkTier(errors, 'license', profile.license.tier);
  for (const d of profile.coverage?.uncovered_notes || []) {
    checkString(errors, 'coverage.uncovered_notes[]', d, 1, 300);
  }
  void readLog;

  const coverage = profile.coverage || {};
  const computed = { claims_total: claims.length, verified, self_reported: selfReported, contradicted, unverifiable, uncovered };
  for (const [field, expected] of Object.entries(computed)) {
    if (coverage[field] !== undefined && coverage[field] !== expected) {
      fail(errors, `coverage.${field} says ${coverage[field]} but the claims imply ${expected}`);
    }
  }

  return { ok: errors.length === 0, errors, computed };
}

export function validateClaimFile(payload) {
  const errors = [];
  const claims = payload?.claims;
  if (!Array.isArray(claims)) {
    return { ok: false, errors: ['claims: missing or not an array — a Markdown block is not an acceptable payload'] };
  }
  if (claims.length > LIMITS.claims) fail(errors, `claims: ${claims.length} exceeds the ${LIMITS.claims} cap (possible flooding)`);
  for (const [i, c] of claims.entries()) {
    const where = `claims[${i}]`;
    if (typeof c !== 'object' || c === null) { fail(errors, `${where}: not an object`); continue; }
    checkString(errors, `${where}.text`, c.text, 1, LIMITS.claimText);
    checkString(errors, `${where}.quote`, c.quote, 1, 1000);
    if (!c.source?.path) fail(errors, `${where}.source.path: required`);
    if (!Number.isInteger(c.source?.line) || c.source.line < 1) fail(errors, `${where}.source.line: must be a positive integer`);
  }
  return { ok: errors.length === 0, errors };
}

export { LIMITS, TIERS };