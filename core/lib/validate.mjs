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

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
// Refuse to load an arbitrarily large file just to search it for a quoted string.
const QUOTE_FILE_CAP = 4 * 1024 * 1024;
// A citation is positional evidence: the quotation should begin at the line cited. This much slack
// covers an off-by-one and a quote whose first line follows a heading, and no more — at 12 lines a
// padded quote still matched four lines away from where it was cited.
const MAX_QUOTE_LINE_SPAN = 3;
// Two words and eight non-space characters: enough to be a quotation, not enough to be found anywhere.
const MIN_QUOTE_TOKENS = 2;
const MIN_QUOTE_CHARS = 8;

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
  const files = new Map();
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

    // The profile is the artifact that gets rendered, so a claim without a verified quotation is the
    // one shape that reaches the reader unevidenced. Quoting was previously checked only in
    // analysis.json, whose quotes are never printed — the gate protected the wrong file.
    verifyQuote(errors, where, c, root, files);

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
      // Persist what was actually shared. The renderer used to restate the relationship in its own
      // words and got it wrong; deriving the sentence from a recorded value removes that class of bug.
      if (shared.length) {
        const realRoot = canonicalIn(root, '.');
        c.shared_files = shared.map((f) => relative(realRoot, f) || f);
      }
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

// Compare text under progressively looser equivalence, returning the name of the rule that matched or
// null. The order matters: exact first, then whitespace, then typography. A model transcribing a line
// out of a Markdown file legitimately loses the file's line wrapping and may normalise curly quotes to
// ASCII. Those are transcription artefacts, not fabrication, and rejecting them would push authors
// toward paraphrasing a quote until it stopped being a quote.
const EQUIVALENCE = [
  ['exact', (text) => text, '\n'],
  ['whitespace', (text) => text.replace(/\s+/g, ' ').trim(), ' '],
  // U+00A0 is already \s, so the whitespace rule above has normalised it and no nbsp pass is needed.
  ['whitespace+typography', (text) => text
    .replace(/\s+/g, ' ').trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-'), ' '],
];

function normaliseNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

// Fold the file line by line while recording, for every character of the folded text, the line it came
// from. Folding the whole document at once destroys the newlines, so an offset in the folded string no
// longer identifies a line — and citing the wrong line is precisely what this check exists to catch.
function foldWithLineMap(lines, fold, joiner) {
  const segments = [];
  const lineOf = [];
  for (let i = 0; i < lines.length; i++) {
    const folded = fold(lines[i]);
    if (!folded) continue;
    if (segments.length) {
      segments.push(joiner);
      lineOf.push(i + 1);
    }
    for (let j = 0; j < folded.length; j++) lineOf.push(i + 1);
    segments.push(folded);
  }
  return { folded: segments.join(''), lineOf };
}

// Locate a quote in a file, returning { line, rule } for the occurrence nearest the cited line.
// Proximity matters as much as presence: a claim citing README line 1 and quoting line 500 is not
// fabricating, but it is citing a file that does not support the citation as written, and the reader
// of the report has no way to tell.
function locateQuote(entry, quote, citedLine) {
  const lines = entry.lines;
  const target = normaliseNewlines(quote);
  let best = null;

  for (const [rule, fold, joiner] of EQUIVALENCE) {
    const needle = fold(target);
    if (!needle) return null;
    let view = entry.folded.get(rule);
    if (!view) {
      view = foldWithLineMap(lines, fold, joiner);
      entry.folded.set(rule, view);
    }
    const { folded, lineOf } = view;
    let from = 0;
    for (;;) {
      const at = folded.indexOf(needle, from);
      if (at === -1) break;
      const line = lineOf[at] ?? 1;
      if (!best || Math.abs(line - citedLine) < Math.abs(best.line - citedLine)) best = { line, rule };
      from = at + 1;
    }
    if (best) break;
  }
  return best;
}

// A claim's quote must actually occur in the file it cites. Every other field in a claim payload can be
// written by a model, and a plausible invented quote — "independently audited by a third party",
// "handles 10000 requests per second" — passes every structural check the validator used to make.
// Found by hand-writing impossible claims for a real repository and watching the pipeline accept them.
// This is the check that turns a citation from an assertion into evidence.
export function verifyQuote(errors, where, claim, root, files = new Map()) {
  const cited = claim?.source?.path;
  const citedLine = claim?.source?.line;
  const quote = claim?.quote;

  if (typeof cited !== 'string' || !cited) {
    fail(errors, `${where}.source.path: required and must be a string, got ${JSON.stringify(cited)}`);
    return false;
  }
  if (!Number.isInteger(citedLine) || citedLine < 1) {
    fail(errors, `${where}.source.line: must be a positive integer, got ${JSON.stringify(citedLine)}`);
    return false;
  }
  if (typeof quote !== 'string') {
    fail(errors, `${where}.quote: must be a string, got ${typeof quote}`);
    return false;
  }
  // A one-character quote matches almost any file, so `text: "audited by a third party"` with
  // `quote: "e"` passes: measured, every line of a prose file accepted a single-vowel quote. A quote
  // must carry enough text to be evidence, not enough to be found.
  const tokens = quote.trim().split(/\s+/).filter(Boolean);
  const significant = quote.replace(/\s+/g, '').length;
  if (tokens.length < MIN_QUOTE_TOKENS || significant < MIN_QUOTE_CHARS) {
    fail(errors, `${where}.quote: ${JSON.stringify(quote)} is too short to be evidence — a quote must span at least 2 words and 8 non-space characters`);
    return false;
  }
  if (!quote.trim()) {
    fail(errors, `${where}.quote: empty — a quote is the text the repository contains, and there is none`);
    return false;
  }

  const real = checkCitedFile(errors, `${where}.source.path`, cited, root);
  if (!real) return false;

  let stat;
  try {
    stat = statSync(real);
  } catch {
    return fail(errors, `${where}.source.path: cited file ${JSON.stringify(cited)} could not be read`);
  }
  // Refuse to slurp a multi-gigabyte blob into memory to search it for a string.
  if (stat.size > QUOTE_FILE_CAP) {
    return fail(errors, `${where}.source.path: cited file is ${stat.size} bytes, over the ${QUOTE_FILE_CAP} cap for quote verification`);
  }

  let entry = files.get(real);
  if (entry === undefined) {
    let read = null;
    try {
      read = readFileSync(real, 'utf8');
    } catch {
      return fail(errors, `${where}.source.path: cited file ${JSON.stringify(cited)} could not be read`);
    }
    // A NUL byte means this is not a text document. Searching binary for a substring proves nothing.
    entry = read.includes('\u0000')
      ? { binary: true }
      : { lines: normaliseNewlines(read).split('\n'), folded: new Map() };
    files.set(real, entry);
  }
  if (entry.binary) {
    return fail(errors, `${where}.source.path: cited file ${JSON.stringify(cited)} is not a text file`);
  }
  const lineCount = entry.lines.length;
  if (citedLine > lineCount) {
    return fail(errors, `${where}.source.line: line ${citedLine} is past the end of ${JSON.stringify(cited)} (${lineCount} lines)`);
  }

  const hit = locateQuote(entry, quote, citedLine);
  if (!hit) {
    const preview = quote.length > 60 ? `${quote.slice(0, 57)}...` : quote;
    return fail(errors, `${where}.quote: ${JSON.stringify(preview)} does not appear in ${JSON.stringify(cited)} — a quote must be text the repository actually contains`);
  }

  // Allow a quote that spans lines, plus a little slack for an off-by-one citation. Counted from
  // non-blank lines and capped: a quote padded with newlines otherwise reached a 1002-line tolerance,
  // which makes the citation positionally meaningless. Blank lines are padding, not content.
  const contentLines = normaliseNewlines(quote).split('\n').filter((l) => l.trim()).length;
  const span = Math.min(contentLines + 2, MAX_QUOTE_LINE_SPAN);
  if (Math.abs(hit.line - citedLine) > span) {
    return fail(errors, `${where}.source.line: cited line ${citedLine} but the quote is on line ${hit.line} of ${JSON.stringify(cited)}`);
  }
  return true;
}

export function validateClaimFile(payload, { key } = {}) {
  // One pass over a file per claim is quadratic in the claims a hostile payload can send: measured at
  // ~10s for 200 claims against a 4 MiB file. Cache per validation run.
  const files = new Map();
  const errors = [];
  const claims = payload?.claims;
  if (!Array.isArray(claims)) {
    return { ok: false, errors: ['claims: missing or not an array — a Markdown block is not an acceptable payload'] };
  }
  // Fail closed. Without a clone there is nothing to check a quote against, and a validator that
  // quietly skips the one check that distinguishes evidence from assertion is worse than no validator.
  if (!key) {
    return { ok: false, errors: ['claims: quote verification needs the repo key so the cited file can be read — refusing to accept unverified claims'] };
  }
  // The key becomes the containment root for every cited file, so its shape is a security property,
  // not a convenience. Taken straight off argv it must satisfy the same shape repoKey() produces.
  if (!/^[a-z0-9.-]+\.[a-z0-9._-]+$/.test(key)) {
    return { ok: false, errors: [`claims: repo key ${JSON.stringify(key)} is not a valid owner.repo key, so no clone can be identified`] };
  }
  const root = repoDir(key);
  if (!existsSync(root)) {
    return { ok: false, errors: [`claims: no clone at ${root} — claims cannot be verified against a repository that is not present`] };
  }

  if (claims.length > LIMITS.claims) fail(errors, `claims: ${claims.length} exceeds the ${LIMITS.claims} cap (possible flooding)`);
  for (const [i, c] of claims.entries()) {
    const where = `claims[${i}]`;
    if (typeof c !== 'object' || c === null) { fail(errors, `${where}: not an object`); continue; }
    checkString(errors, `${where}.text`, c.text, 1, LIMITS.claimText);
    checkString(errors, `${where}.quote`, c.quote, 1, 1000);
    if (!c.source?.path) fail(errors, `${where}.source.path: required`);
    if (!Number.isInteger(c.source?.line) || c.source.line < 1) fail(errors, `${where}.source.line: must be a positive integer`);
    verifyQuote(errors, where, c, root, files);
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