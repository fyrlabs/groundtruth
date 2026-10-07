#!/usr/bin/env node
// Hook plumbing shared by every guard.
//
// IMPORTANT, and stated plainly because it is easy to overstate: **hooks are advisory.** A
// project-level .claude/settings.json can set disableAllHooks, which turns off user, project,
// local and plugin hooks alike. Only managed settings survive that. So the structural defences —
// cloning outside the project tree, refusing control files, agent tool grants, and validator
// enforcement — are the real boundary, and these hooks are defence in depth on top of them.

import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PLUGIN_ROOT = resolve(HERE, '..');

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Hooks must emit exactly one JSON document and stop. A guard that emits a decision and then falls
// through emits a second document, and Claude Code reads the extra output as part of the tool
// result — so the guard appears not to fire at all.
function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

// Block. `reason` is what the agent sees, so it should say what to do instead.
export function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

// Warn without blocking, and add context the agent should factor in.
export function warn(reason, extra = {}) {
  emit({ systemMessage: reason, hookSpecificOutput: { hookEventName: extra.event || 'PostToolUse', additionalContext: reason } });
}

// Replace the tool result the agent is about to see. Note that `decision: "block"` does NOT do
// this — the docs are explicit that the original output is still shown and only annotated — so the
// injection defence has to replace the text rather than comment on it.
export function replaceOutput(updatedToolOutput, extraContext) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput,
      additionalContext: extraContext,
    },
  });
}

export function allow() {
  emit({});
}

export function toolInputPath(input = {}) {
  return input.file_path || input.path || input.notebook_path || input.pattern || '';
}

// The clone root. Content under it is untrusted by definition. Must agree with core/lib/paths.mjs —
// a guard that watches a different directory than the one clone.mjs writes to protects nothing.
export function cloneRoot() {
  if (process.env.GROUNDTRUTH_CLONE_DIR) return resolve(process.env.GROUNDTRUTH_CLONE_DIR);
  return join(process.env.HOME || '', '.cache', 'groundtruth', 'sources');
}

export function stateRoot() {
  if (process.env.GROUNDTRUTH_STATE_DIR) return resolve(process.env.GROUNDTRUTH_STATE_DIR);
  if (process.env.CLAUDE_PLUGIN_DATA) return join(resolve(process.env.CLAUDE_PLUGIN_DATA), 'groundtruth');
  return join(process.cwd(), '.claude', 'groundtruth');
}

export function logEvent(kind, data) {
  try {
    const dir = join(stateRoot(), 'audit');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hooks.jsonl'), `${JSON.stringify({ kind, at: new Date().toISOString(), ...data })}\n`);
  } catch {
    // Auditing must never break a tool call.
  }
}

// The read log is what makes a citation mean "this agent looked at it" rather than "this agent named
// it" — the validator rejects any cited file that is not recorded here for that agent. Written here
// because the hook sees every read regardless of which tool performed it.
export function recordRead(payload) {
  try {
    const input = payload.tool_input || {};
    const raw = input.file_path || input.path || input.notebook_path || input.pattern || '';
    if (!raw) return;
    const absolute = resolve(String(raw));
    const clone = cloneRoot();
    if (absolute !== clone && !absolute.startsWith(clone + sep)) return;

    // Convert back to the clone-relative, canonical spelling the validator will look for.
    const rel = relative(clone, absolute);
    // Derive the repo key from the path rather than requiring an environment variable. Clones are
    // laid out as <cloneRoot>/<owner.repo>/..., so the first segment *is* the key. The orchestrator
    // never set GROUNDTRUTH_REPO_KEY, so every read went unlogged, the read log was never created, and
    // every verdict citing a file was rejected — the pipeline could not complete. Found by running the
    // plugin end to end against a real repository.
    const fromPath = rel.split(sep)[0];
    const key = process.env.GROUNDTRUTH_REPO_KEY || fromPath;
    if (!key || !/^[a-z0-9.-]+\.[a-z0-9._-]+$/.test(key)) return;

    const dir = join(stateRoot(), 'repos', key);
    mkdirSync(dir, { recursive: true });
    // realpath: /tmp and /private/tmp name the same file, and the validator canonicalises before
    // comparing, so the log has to carry the canonical spelling.
    let canonicalPath = absolute;
    try {
      canonicalPath = realpathSync(absolute);
    } catch {
      // A read of a path that no longer exists still gets logged; canonicalIn will simply not match.
    }
    appendFileSync(join(dir, 'reads.jsonl'), `${JSON.stringify({
      agent: payload.agent_type || payload.agent_id || 'unknown',
      path: canonicalPath,
      tool: payload.tool_name || '',
      at: new Date().toISOString(),
    })}\n`);
  } catch {
    // Recording must never break a tool call.
  }
}

export function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}