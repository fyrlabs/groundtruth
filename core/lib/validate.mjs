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

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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

// Canonical path identity, used for both the containment check and the correlation check. Two
// spellings of one file must compare equal, or a model varying capitalisation defeats the
// correlation rule on any case-insensitive volume.
export function canonicalIn(root, target) {
  const absolute = resolve(join(root, target));
  try {
    return realpathSync(absolute);
  } catch {
    // The leaf may not exist; canonicalise the longest existing ancestor and re-attach.
    let current = absolute;
    const parts = [];
    for (;;) {
      const parent = dirname(current);
      if (parent === current) return absolute;
      parts.unshift(current.split(sep).pop());
      try {
        return join(realpathSync(parent), ...parts);
      } catch {
        current = parent;
      }
    }
  }
}

// A cited path must be a real *file* whose realpath is inside the clone root. Three separate checks,
// each catching something the previous one missed:
//   - resolve() is purely lexical and does not follow symlinks, so a symlink inside the clone
//     pointing at /etc/passwd satisfied a string prefix test
//   - existsSync() is true for directories, so a claim could cite "src" or "." as evidence
//   - .git is skipped by clone-time inspection, so it is never checked for control files but was
//     still citable
function checkCitedFile(errors, where, cited, root) {
  if (typeof cited !== 'string' || !cited) return fail(errors, `${where}: cited_files entry is empty`);
  if (cited.startsWith('/') || cited.includes('..')) {
    return fail(errors, `${where}: cited path ${JSON.stringify(cited)} escapes the clone root`);
  }
  if (cited.split('/').includes('.git')) {
    return fail(errors, `${where}: cited path ${JSON.stringify(cited)} is inside the git directory, which is not project content`);
  }

  const realRoot = canonicalIn(root, '.');
  const real = canonicalIn(root, cited);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return fail(errors, `${where}: cited path ${JSON.stringify(cited)} resolves outside the clone root via a symlink`);
  }

  let stat;
  try {
    stat = statSync(real);
  } catch {
    return fail(errors, `${where}: cited file ${JSON.stringify(cited)} does not exist in the clone`);
  }
  if (!stat.isFile()) {
    return fail(errors, `${where}: cited path ${JSON.stringify(cited)} is a ${stat.isDirectory() ? 'directory' : 'non-file'}, not evidence`);
  }
  return real;
}

// Paths are lowercased on both sides because the volume may be case-insensitive, and keyed by agent
// so a verdict can only cite what *that* agent read.
function loadReadLog(key) {
  try {
    const file = join(repoStateDir(key), 'reads.jsonl');
    const byAgent = new Map();
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a truncated final line from an interrupted append
      }
      if (!entry?.path) continue;
      if (!byAgent.has(entry.agent)) byAgent.set(entry.agent, new Set());
      byAgent.get(entry.agent).add(String(entry.path).toLowerCase());
    }
    return byAgent;
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

      const real = new Set();
      for (const f of files) {
        const resolved = checkCitedFile(errors, vw, f, root);
        if (resolved) real.add(resolved.toLowerCase());
        if (!citedByVerdict.has(v.agent)) citedByVerdict.set(v.agent, new Set());
        for (const g of citedByVerdict.get(v.agent)) g.add(resolved ? resolved.toLowerCase() : f.toLowerCase());
      }

      // The read log is what makes a citation mean "this agent looked at it" rather than "this agent
      // named it". It is recorded by the PostToolUse hook, one line per read, tagged with the agent.
      // Absent log means the stage ran without instrumentation, so this is reported rather than
      // assumed — fail closed, because the alternative is a check that silently never fires.
      if (readLog) {
        const agentReads = readLog.get(v.agent);
        for (const f of real) {
          if (!agentReads?.has(f)) {
            fail(errors, `${vw}: cited file ${JSON.stringify(f)} is not in the read log for ${v.agent} — ` +
              'the verdict names a file that agent did not read this run');
          }
        }
      } else if (enforceReads) {
        fail(errors, `${vw}: no read log for this repo, so cited_files cannot be verified against it`);
      }
    }

    // Correlation check. Agreement is only informative when it rests on distinct evidence: if the
    // union of everything every agent cited is no larger than any single agent's own set, then no
    // agent saw anything the others did not, and the agreement carries no independent weight.
    // Compare canonical paths, not strings: README.md and readme.MD are one file on a
    // case-insensitive volume, and ./README.md is the same file spelled differently. Comparing raw
    // strings let a model defeat the correlation rule by varying its capitalisation.
    const canonicalSets = verdicts.map((v) => new Set(
      (v.cited_files || []).map((f) => canonicalIn(root, f)).map((p) => p.toLowerCase()),
    ));

    const distinctAgents = new Set(verdicts.map((v) => v.agent));
    if (distinctAgents.size > 1) {
      // Any file cited by more than one agent is shared evidence. Overlap is what matters, not whether
      // one agent's set happens to cover the union: two agents on README.md plus a third on a
      // different file is still two opinions from one source.
      const counts = new Map();
      for (const set of canonicalSets) {
        for (const f of set) counts.set(f, (counts.get(f) || 0) + 1);
      }
      const shared = [...counts.entries()].filter(([, n]) => n > 1).map(([f]) => f);
      const fullyShared = shared.length > 0 && counts.size === shared.length;

      // Same-source agreement must be DISCLOSED, not downgraded. One agent reading the actual file
      // is code verification on its own terms — the tier answers "was this confirmed by reading the
      // code", and it was. What would mislead is implying three agents confirmed it independently,
      // so that is what gets blocked: an undisclosed correlated claim is rejected, a disclosed one is
      // accepted with its tier intact.
      //
      // An earlier revision blocked the tier itself, which was wrong twice over. It forced a false
      // downgrade on a licence claim where two agents applied genuinely different arguments to the
      // same file, and it conflated "is this verified" with "was this independently verified" — two
      // different questions that belong in two different fields.
      if (shared.length && c.correlated !== true) {
        fail(errors, `${where}: agents share evidence (${shared.join(', ')}) — their agreement carries no ` +
          'independent weight, so it must be disclosed with correlated: true. The tier may stand if the ' +
          'cited file genuinely settles the claim.');
      }
      if (!shared.length && distinctAgents.size > 1 && c.correlated === true) {
        fail(errors, `${where}.correlated is true but the agents cited distinct files`);
      }
    }
    void citedByVerdict; // retained for debugging; correlation uses canonicalIn below

    if (c.tier === 'code-verified') {
      const backing = verdicts.filter((v) => v.tier === 'code-verified');
      if (backing.length === 0) fail(errors, `${where}: tier is code-verified but no verdict confirms it`);
      for (const v of backing) {
        // Every cited path was already checked above; this loop exists only to guarantee the
        // code-verified path is covered by the same existence and containment rules.
        for (const f of v.cited_files || []) {
          if (!checkCitedFile(errors, where, f, root)) {
            fail(errors, `${where}: code-verified cites ${JSON.stringify(f)}, which is not a readable file in the clone`);
          }
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

// The four verifier stages share one shape: a list of verdicts, each citing files, plus stage-specific
// extras the reconciler reads. Validating them here rather than only profile-shaped payloads is what
// stops a malformed verdict from reaching the reconciler and becoming a tier.
const VERDICT_STAGE_EXTRAS = {
  technical: ['dependency_health', 'code_observations'],
  community: ['license', 'authorship', 'health', 'distribution', 'flags'],
  conflicts: ['platform_support', 'install', 'conflicts', 'dependency_risk'],
  spotcheck: ['live', 'advisories', 'deprecation', 'independent_sources', 'reception'],
  drift: ['drift_level', 'reason', 'recorded_sha', 'remote_sha'],
};

const ALLOWED_DRIFT_LEVELS = new Set(['NO_DRIFT', 'CONTENT_DRIFT', 'SEMANTIC_DRIFT', 'UNKNOWN_DRIFT']);

export function validateVerdictFile(payload, { stage } = {}) {
  const errors = [];
  const extras = VERDICT_STAGE_EXTRAS[stage];
  if (!extras) return { ok: true, errors: [] };

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: ['payload: must be a JSON object'] };
  }

  const verdicts = payload.verdicts;
  if (verdicts !== undefined) {
    if (!Array.isArray(verdicts)) {
      fail(errors, 'verdicts: must be an array');
    } else if (verdicts.length > LIMITS.claims) {
      fail(errors, `verdicts: ${verdicts.length} exceeds the ${LIMITS.claims} cap`);
    } else {
      for (const [i, v] of verdicts.entries()) {
        const where = `verdicts[${i}]`;
        if (!v || typeof v !== 'object') { fail(errors, `${where}: not an object`); continue; }
        if (!/^c[0-9]{1,3}$/.test(String(v.claim_id || ''))) fail(errors, `${where}.claim_id: must match c<number>`);
        checkTier(errors, where, v.tier);
        const files = Array.isArray(v.cited_files) ? v.cited_files : [];
        if (files.length === 0) fail(errors, `${where}.cited_files: empty — a verdict with no citation is a guess`);
        if (files.length > LIMITS.citedFiles) fail(errors, `${where}.cited_files: ${files.length} exceeds ${LIMITS.citedFiles}`);
        for (const f of files) {
          if (typeof f !== 'string' || !f || f.startsWith('/') || f.includes('..')) {
            fail(errors, `${where}.cited_files: ${JSON.stringify(f)} is not a clone-relative path`);
          }
        }
        checkString(errors, `${where}.summary`, v.summary, 1, 800, { required: false });
        if (v.downgrade) {
          for (const d of v.downgrade) {
            if (!DOWNGRADES.has(d)) fail(errors, `${where}.downgrade: unknown domain ${JSON.stringify(d)}`);
          }
        }
      }
    }
  }

  if (stage === 'drift') {
    if (!ALLOWED_DRIFT_LEVELS.has(payload.drift_level)) {
      fail(errors, `drift_level: must be one of ${[...ALLOWED_DRIFT_LEVELS].join(', ')}`);
    }
    checkString(errors, 'reason', payload.reason, 1, LIMITS.summary);
    // An undecidable comparison must escalate, never default into a full re-analysis.
    if (payload.drift_level === 'UNKNOWN_DRIFT' && payload.recommendation) {
      fail(errors, 'UNKNOWN_DRIFT must not carry a recommendation — it escalates to the user');
    }
  }

  if (stage === 'community' && payload.license) {
    const ok = ['yes', 'no', 'source-available-only', 'unknown'];
    if (!ok.includes(payload.license.oss_compatible)) {
      fail(errors, `license.oss_compatible: must be one of ${ok.join(', ')}`);
    }
    checkTier(errors, 'license', payload.license.tier);
  }

  if (stage === 'spotcheck' && !payload.observed_at) {
    fail(errors, 'observed_at: live data must carry the date it was observed');
  }

  for (const extra of extras) {
    if (payload[extra] === undefined) continue;
    if (typeof payload[extra] !== 'object' || payload[extra] === null) {
      fail(errors, `${extra}: expected an object or array`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export { LIMITS, TIERS, ALLOWED_DRIFT_LEVELS };