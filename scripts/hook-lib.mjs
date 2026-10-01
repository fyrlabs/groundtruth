#!/usr/bin/env node
// Hook plumbing shared by every guard.
//
// IMPORTANT, and stated plainly because it is easy to overstate: **hooks are advisory.** A
// project-level .claude/settings.json can set disableAllHooks, which turns off user, project,
// local and plugin hooks alike. Only managed settings survive that. So the structural defences —
// cloning outside the project tree, refusing control files, agent tool grants, and validator
// enforcement — are the real boundary, and these hooks are defence in depth on top of them.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

export function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}