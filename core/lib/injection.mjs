// Prompt-injection detection and scrubbing.
//
// This is detection, not prevention — the prevention is structural (clone outside the project tree,
// refuse control files, deny reads under the clone root for instruction-shaped paths). What this
// module buys is evidence: which repos attempted injection, so a run can be audited, and so the
// scrubbed text an agent sees is not the raw payload.
//
// Two distinct attacks, deliberately handled differently:
//
//   1. Instruction injection — "ignore previous instructions", fake role markers, fake tool output.
//      Scrubbed out of tool results before the agent reads them.
//
//   2. Output-format forgery — a README containing a block shaped like `## ANALYSIS_REPORT`. This
//      is *data shaped like our output*, not an instruction, so no instruction-level preamble can
//      catch it. It is handled structurally by the validator: a forged verdict must cite a file the
//      attacker did not read (see validate.mjs). Here we only flag it, because knowing a repo tried
//      is worth recording even though the validator already neutralises it.

const PATTERNS = [
  { kind: 'instruction-override', re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(?:instruction|prompt|rule|direction)s?\b/i },
  { kind: 'instruction-override', re: /\b(?:new|updated|revised)\s+(?:instruction|directive|rule)s?\s*:/i },
  // A role marker at line start, but only when what follows reads as an instruction. Requiring any
  // non-space character after the colon matched ordinary `user:` and `system:` keys in YAML, protobuf,
  // INI and shell, so the scrubber corrupted legitimate config files it was supposed to be preserving.
  // Leading markdown emphasis is allowed because a README heading or bold is the natural way to phrase
  // the attack.
  // Markdown emphasis inside the marker is common in a README, so allow `**`/`*`/`_` around it; allow
  // at most one extra colon-separated role ("system: assistant: ...") since that is the same attack.
  // Emphasis may wrap the marker on either side (`**system**: ignore …`), and at most one extra
  // role may be chained (`system: assistant: …`), which is the same attack. "admin" is deliberately
  // absent: `user: admin` is ordinary configuration, and flagging it corrupts the evidence the
  // pipeline exists to preserve.
  { kind: 'role-spoof', re: /^[ \t>*_#-]{0,4}\*?\*?\s*(?:system|assistant|user|developer)\*?\*?\s*:\s*\*?\*?\s*(?:(?:system|assistant|user|developer)\*?\*?\s*:\s*)?(?:ignore|disregard|forget|override|you|now|new|approved|confirmed|verified|bypass|from now|the operator|do not cite|emit)/im },
  { kind: 'role-spoof', re: /<\|?(?:im_start|im_end|system|endoftext)\|?>/i },
  { kind: 'tool-output-spoof', re: /^\s*(?:tool_result|function_results?|observation)\s*[:=]\s*\[?\{/im },
  { kind: 'output-forgery', re: /^#{1,3}\s*(?:ANALYSIS_REPORT|TECHNICAL_VERIFICATION|COMMUNITY_VERIFICATION|CONFLICTS_VERIFICATION|ONLINE_SPOT_CHECK|DRIFT_REPORT|DISCOVERY_CANDIDATES|TRIAGE_RESULTS|RECONCILIATION_SUMMARY)\b/m },
  // A verdict symbol or word appearing in a table row or an assertion, i.e. anywhere the repo is
  // speaking as if it were the pipeline rather than as a subject being analysed.
  { kind: 'verdict-injection', re: /(?:code-verified|self-reported|contradicted|unverifiable)\s*\|\s*(?:✅|⚠️|❌|🔍)|(?:✅|⚠️|❌|🔍)\s+(?:code-verified|self-reported|contradicted|unverifiable)|\ball\s+claims\b[^\n]{0,40}\bcode-verified\b/i },
  { kind: 'exfiltration', re: /\b(?:curl|wget|fetch)\b[^\n]{0,80}\b(?:cat|id_rsa|\.env|credentials|\.aws|\.ssh)/i },
  { kind: 'shell-pipe', re: /(?:curl|wget)\s+[^\n|]{0,200}\|\s*(?:ba)?sh/i },
  { kind: 'tool-approval-request', re: /\b(?:allowed-tools|allowed_tools)\s*:\s*[^\n]*(?:Bash|Write|Edit)/i },
  { kind: 'hook-injection', re: /PreToolUse\s*:\s*|PostToolUse\s*:/ },
  // The delimiters this renderer emits between profiles. A repo that contains these is trying to make
  // its content look like part of the report rather than like a subject of it.
  { kind: 'delimiter-forgery', re: /<!--\s*\/?groundtruth:(?:profile|analysis)[:/]/ },
  // Greedy, so a run of N hidden characters is ONE match and becomes one marker — which is what keeps
  // a file of zero-width characters from expanding ~68x on the way out. A single bidi override is
  // meaningful on its own, so the quantifier starts at one; requiring two missed that.
  { kind: 'hidden-unicode', re: /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]+/ },
];

export function scan(text, { path = '' } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const found = new Map();
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) found.set(kind, { file: path, kind, snippet: m[0].slice(0, 120).replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '') });
  }
  return [...found.values()];
}

// Replace detected spans rather than deleting the file, so the agent still sees that the file had
// content and can reason about the repo — it just cannot be handed a working instruction or verdict.
//
// Detection alone is not neutralisation. A span that is reported but left intact is still a span an
// agent matching on our own output shape can copy, so every detected span is replaced. It is
// *described* rather than reproduced: escaping or case-swapping leaves the text readable to a model,
// which is enough for an instruction to be reassembled and obeyed, whereas a length-and-kind
// description carries the audit signal and cannot be reassembled at all.
export function scrub(text, { path = '' } = {}) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', detections: [] };
  const detections = [];
  let out = text;

  for (const { kind, re } of PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let hit = re.exec(text);
    if (!hit) continue;
    detections.push({ file: path, kind, snippet: hit[0].slice(0, 120) });
    // hit.index, not hit[0].index: the latter is String.prototype.index, a *search method*, so it was
    // undefined and every marker pointed at end-of-file.
    out = out.replace(global, () => quarantine(kind, hit.index, text));
    // Re-check: replacing one span can expose another underneath it.
    hit = re.exec(out);
    if (hit) detections.push({ file: path, kind, snippet: hit[0].slice(0, 120) });
  }

  return { text: out, detections };
}

function quarantine(kind, index, source) {
  const line = source.slice(0, index).split('\n').length;
  return `[groundtruth: quarantined ${kind} at line ${line} — not reproduced]`;
}

export { PATTERNS };