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
  { kind: 'role-spoof', re: /^\s*(?:system|assistant|user|developer)\s*:\s*(?:ignore|you|now|new)/im },
  { kind: 'role-spoof', re: /<\|?(?:im_start|im_end|system|endoftext)\|?>/i },
  { kind: 'tool-output-spoof', re: /^\s*(?:tool_result|function_results?|observation)\s*[:=]\s*\[?\{/im },
  { kind: 'output-forgery', re: /^#{1,3}\s*(?:ANALYSIS_REPORT|TECHNICAL_VERIFICATION|COMMUNITY_VERIFICATION|CONFLICTS_VERIFICATION|ONLINE_SPOT_CHECK|DRIFT_REPORT|DISCOVERY_CANDIDATES|TRIAGE_RESULTS|RECONCILIATION_SUMMARY)\b/m },
  { kind: 'verdict-injection', re: /(?:code-verified|self-reported|contradicted|unverifiable)\s*\|\s*(?:✅|⚠️|❌|🔍)|(?:✅|⚠️|❌|🔍)\s+(?:code-verified|self-reported|contradicted|unverifiable)/ },
  { kind: 'exfiltration', re: /\b(?:curl|wget|fetch)\b[^\n]{0,80}\b(?:cat|id_rsa|\.env|credentials|\.aws|\.ssh)/i },
  { kind: 'shell-pipe', re: /(?:curl|wget)\s+[^\n|]{0,200}\|\s*(?:ba)?sh/i },
  { kind: 'tool-approval-request', re: /\b(?:allowed-tools|allowed_tools)\s*:\s*[^\n]*(?:Bash|Write|Edit)/i },
  { kind: 'hook-injection', re: /PreToolUse\s*:\s*|PostToolUse\s*:/ },
  { kind: 'hidden-unicode', re: /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/ },
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
// content and can reason about the repo — it just cannot be handed a working instruction.
export function scrub(text, { path = '' } = {}) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', detections: [] };
  const detections = [];
  let out = text;

  for (const { kind, re } of PATTERNS) {
    if (kind === 'output-forgery' || kind === 'verdict-injection') continue;
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), (match) => {
      detections.push({ file: path, kind, snippet: match.slice(0, 120) });
      // Break the pattern rather than merely relocating it: bracketing every character preserves the
      // original text and lets an instruction-matching model reassemble it, which is why the earlier
      // version of this function left "Ignore all previous instructions" fully intact.
      // Describe the span rather than reproduce it. Case-swapping or escaping leaves the text
      // readable to a model, which is enough for an instruction to be reassembled and obeyed; a
      // length-and-kind description carries the audit signal and cannot be reassembled at all.
      const line = text.slice(0, text.indexOf(match)).split('\n').length;
      return `[groundtruth: quarantined ${kind}, ${match.length} chars at line ${line} — not reproduced]`;
    });
  }

  // Flag forged output blocks without destroying the surrounding documentation.
  for (const { kind, re } of PATTERNS) {
    if (kind !== 'output-forgery' && kind !== 'verdict-injection') continue;
    if (re.test(text)) detections.push({ file: path, kind, snippet: kind });
  }

  return { text: out, detections };
}

export { PATTERNS };