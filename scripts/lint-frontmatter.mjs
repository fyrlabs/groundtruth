// Harness-neutral frontmatter lint.
//
// Claude Code silently ignores frontmatter fields it does not recognise: a typo'd `tool:` yields an
// agent with full tool access and no diagnostic. For something people install from a registry, that
// is a supply-chain hazard, not a cosmetic issue.
//
// Two schemas, not one. Plugin agents accept a *reduced* field set, and the fields they drop are
// dropped without warning — so a lint built on the ~/.claude/agents/ table would happily accept
// `permissionMode` in a plugin agent, where it does nothing.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// https://code.claude.com/docs/en/sub-agents
const AGENT_FIELDS_LOCAL = new Set([
  'name', 'description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns',
  'skills', 'mcpServers', 'hooks', 'memory', 'background', 'omitClaudeMd', 'effort',
  'isolation', 'color', 'initialPrompt', 'experimental',
]);

// https://code.claude.com/docs/en/plugins/components — reduced set for plugin agents.
const AGENT_FIELDS_PLUGIN = new Set([
  'name', 'description', 'model', 'effort', 'maxTurns', 'tools', 'disallowedTools', 'skills',
  'memory', 'background', 'omitClaudeMd', 'isolation', 'color', 'experimental',
]);

// Silently ignored in plugin agents. Declaring one reads as enforcement and is not.
const AGENT_FIELDS_IGNORED_IN_PLUGIN = ['permissionMode', 'hooks', 'mcpServers', 'initialPrompt'];

const SKILL_FIELDS = new Set([
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation',
  'user-invocable', 'allowed-tools', 'disallowed-tools', 'model', 'effort', 'context', 'agent',
  'background', 'hooks', 'paths', 'shell', 'metadata', 'license', 'compatibility',
]);

const MODELS = new Set(['sonnet', 'opus', 'haiku', 'fable', 'best', 'default', 'inherit', 'opusplan']);

function parseFrontmatter(file) {
  const text = readFileSync(file, 'utf8');
  if (!text.startsWith('---\n')) return { ok: false, error: 'first line is not `---` (frontmatter is only read when it opens the file)' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { ok: false, error: 'unterminated frontmatter' };
  const block = text.slice(4, end);
  const data = {};
  let current = null;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && current) {
      const clean = listItem[1].trim();
      if (!data[current]) data[current] = [];
      if (Array.isArray(data[current])) data[current].push(clean);
      continue;
    }
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    current = key;
    data[key] = value === '' ? [] : /^\[.*\]$/.test(value.trim()) ? value.trim().slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) : value.trim();
  }
  return { ok: true, data, body: text.slice(end + 4) };
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

export function lintAgentFile(file) {
  const errors = [];
  const parsed = parseFrontmatter(file);
  if (!parsed.ok) return { file, errors: [parsed.error] };
  const { data } = parsed;

  for (const key of Object.keys(data)) {
    if (!AGENT_FIELDS_LOCAL.has(key)) {
      errors.push(`field \`${key}\` is not a recognised subagent field (a typo here is ignored silently, granting full tool access)`);
    }
  }
  for (const key of AGENT_FIELDS_IGNORED_IN_PLUGIN) {
    if (data[key] !== undefined) {
      errors.push(`field \`${key}\` is silently ignored in plugin agents — it reads as enforcement but does nothing`);
    }
  }
  if (!data.name) errors.push('`name` is required');
  else if (String(data.name).includes(':')) errors.push('`name` cannot contain `:` — reserved for plugin scoping');
  else if (String(data.name).startsWith('groundtruth-')) {
    errors.push('`name` must not carry the `groundtruth-` prefix — the plugin namespace already applies it');
  }
  if (!data.description) errors.push('`description` is required (it is how the orchestrator routes work)');
  else if (String(data.description).length < 40) errors.push('`description` is too thin to route reliably');
  if (data.model && !MODELS.has(String(data.model)) && !/^claude-/.test(String(data.model))) {
    errors.push(`model \`${data.model}\` is neither a known alias nor a full model id`);
  }
  if (data.maxTurns !== undefined && !/^\d+$/.test(String(data.maxTurns))) errors.push('`maxTurns` must be an integer');
  return { file, errors, name: data.name, tools: data.tools, data };
}

export function lintSkillFile(file) {
  const errors = [];
  const parsed = parseFrontmatter(file);
  if (!parsed.ok) return { file, errors: [parsed.error] };
  const { data } = parsed;
  for (const key of Object.keys(data)) {
    if (!SKILL_FIELDS.has(key)) errors.push(`field \`${key}\` is not a recognised skill field`);
  }
  if (!data.name) errors.push('`name` is required');
  if (!data.description) errors.push('`description` is required');
  if (data.model && !MODELS.has(String(data.model)) && !/^claude-/.test(String(data.model))) {
    errors.push(`model \`${data.model}\` is unrecognised`);
  }
  return { file, errors, data };
}

export function run() {
  const problems = [];
  let agentCount = 0;
  let skillCount = 0;

  for (const file of walk(join(ROOT, 'agents'))) {
    agentCount += 1;
    const r = lintAgentFile(file);
    problems.push(...r.errors.map((e) => `${file.replace(`${ROOT}/`, '')}: ${e}`));
  }
  for (const file of walk(join(ROOT, 'skills'))) {
    skillCount += 1;
    const r = lintSkillFile(file);
    problems.push(...r.errors.map((e) => `${file.replace(`${ROOT}/`, '')}: ${e}`));
  }

  return { problems, agentCount, skillCount };
}

export { AGENT_FIELDS_LOCAL, AGENT_FIELDS_PLUGIN, AGENT_FIELDS_IGNORED_IN_PLUGIN, SKILL_FIELDS, MODELS, parseFrontmatter };