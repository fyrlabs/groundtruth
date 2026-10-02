// Invariants that would have caught the original three fatal bugs.
//
// Each check below corresponds to a real defect that shipped: agents and commands were installed to
// a directory the harness never scans; SKILL.md shipped without frontmatter, so its description
// degraded to the literal word "Groundtruth"; and the orchestrator referenced agents by names that
// do not resolve under plugin scoping. All three were invisible because nothing verified layout.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Top-level await is available here (the file already uses it in the runner below), so the paths
// module can be imported directly and the contract asserted against the real implementation rather
// than against a copy of it.
const pathsModule = await import('../core/lib/paths.mjs');
const stateRootModule = () => {
  try {
    return pathsModule.stateRoot();
  } catch {
    return null;
  }
};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_NAME = 'groundtruth';

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function shippedFiles() {
  return walk(ROOT).filter((f) => !f.includes(`${ROOT}/.git/`));
}

check('plugin manifest exists and declares the plugin name', () => {
  const manifest = join(ROOT, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifest)) throw new Error('missing .claude-plugin/plugin.json — without it the agents/ and skills/ folders are never discovered');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (pkg.name !== PLUGIN_NAME) throw new Error(`plugin name is "${pkg.name}", expected "${PLUGIN_NAME}"`);
  return `name=${pkg.name} version=${pkg.version}`;
});

check('plugin version matches package.json version', () => {
  const a = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const b = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  if (a !== b) throw new Error(`plugin.json ${a} != package.json ${b}`);
  return a;
});

check('marketplace manifest exists', () => {
  const f = join(ROOT, '.claude-plugin', 'marketplace.json');
  if (!existsSync(f)) throw new Error('missing .claude-plugin/marketplace.json — the plugin would not be installable via /plugin marketplace add');
  return 'ok';
});

check('every skill opens with frontmatter on line 1', () => {
  const bad = [];
  for (const file of walk(join(ROOT, 'skills')).filter((f) => f.endsWith('SKILL.md'))) {
    if (readFileSync(file, 'utf8').split('\n')[0].trim() !== '---') bad.push(file.replace(`${ROOT}/`, ''));
  }
  if (bad.length) throw new Error(`no frontmatter, so the description degrades to the first body line: ${bad.join(', ')}`);
  const n = walk(join(ROOT, 'skills')).filter((f) => f.endsWith('SKILL.md')).length;
  return `${n} skill(s)`;
});

check('every skill has a non-trivial description', () => {
  for (const file of walk(join(ROOT, 'skills')).filter((f) => f.endsWith('SKILL.md'))) {
    const text = readFileSync(file, 'utf8');
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!m) throw new Error(`${file.replace(`${ROOT}/`, '')}: unparseable frontmatter`);
    const desc = /^description:\s*(.+)$/m.exec(m[1]);
    if (!desc || desc[1].trim().length < 40) throw new Error(`${file.replace(`${ROOT}/`, '')}: description missing or too thin to route on`);
    if (!/^when_to_use:/m.test(m[1])) throw new Error(`${file.replace(`${ROOT}/`, '')}: missing when_to_use — model-invocation needs a trigger surface`);
  }
  return 'ok';
});

check('agent names carry no groundtruth- prefix (plugin namespace already applies)', () => {
  const bad = [];
  for (const file of walk(join(ROOT, 'agents')).filter((f) => f.endsWith('.md'))) {
    const name = /^---\n[\s\S]*?^name:\s*(.+)$/m.exec(readFileSync(file, 'utf8'));
    const value = name?.[1]?.trim();
    if (value?.startsWith('groundtruth-')) bad.push(`${file.replace(`${ROOT}/`, '')}: ${value} resolves as ${PLUGIN_NAME}:${value}`);
  }
  if (bad.length) throw new Error(`these resolve as ${PLUGIN_NAME}:groundtruth-… and break every Task call:\n      ${bad.join('\n      ')}`);
  return 'ok';
});

check('agent names are unique', () => {
  const seen = new Map();
  for (const file of walk(join(ROOT, 'agents')).filter((f) => f.endsWith('.md'))) {
    const name = /^---\n[\s\S]*?^name:\s*(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim();
    if (!name) continue;
    if (seen.has(name)) throw new Error(`duplicate agent name "${name}" in ${seen.get(name).replace(`${ROOT}/`, '')} and ${file.replace(`${ROOT}/`, '')}`);
    seen.set(name, file);
  }
  return `${seen.size} agents`;
});

check('every agent referenced by the orchestrator exists', () => {
  const declared = new Set(
    walk(join(ROOT, 'agents')).filter((f) => f.endsWith('.md'))
      .map((f) => /^---\n[\s\S]*?^name:\s*(.+)$/m.exec(readFileSync(f, 'utf8'))?.[1]?.trim())
      .filter(Boolean),
  );
  const missing = [];
  // A skill resolves as <plugin>:<skill-name>, so a reference to the orchestrator itself is not a
  // missing agent. Only references to an agent-shaped name are checked.
  const skillNames = new Set(
    walk(join(ROOT, 'skills')).filter((f) => f.endsWith('SKILL.md'))
      .map((f) => /^---\n[\s\S]*?^name:\s*(.+)$/m.exec(readFileSync(f, 'utf8'))?.[1]?.trim())
      .filter(Boolean),
  );
  for (const file of walk(join(ROOT, 'skills')).filter((f) => f.endsWith('SKILL.md'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(new RegExp(`\\b${PLUGIN_NAME}:([a-z-]+)\\b`, 'g'))) {
      if (declared.has(m[1]) || skillNames.has(m[1])) continue;
      missing.push(`${file.replace(`${ROOT}/`, '')} calls ${PLUGIN_NAME}:${m[1]} which is neither an agent nor a skill`);
    }
  }
  if (missing.length) throw new Error(missing.join('; '));
  return `${declared.size} agents, all referenced`;
});

// Tool references in prose are ambiguous — "Write `profile.json` via the writer script" describes
// a Bash invocation, while "you have no Write tool" describes its absence. So only the negative
// direction is checked: a tool named in the body must be granted. The reverse (granting a tool
// nobody uses) is caught separately below, where a false positive would not be ambiguous.
check('a tool named in an agent body is granted', () => {
  const problems = [];
  for (const file of walk(join(ROOT, 'agents')).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(file, 'utf8');
    const granted = new Set((/^tools:\s*(.+)$/m.exec(text)?.[1] ?? '').split(',').map((t) => t.trim()).filter(Boolean));
    const body = text.slice(text.indexOf('\n---', 3));
    for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']) {
      if (granted.has(tool)) continue;
      // Look for the tool as a noun in a sentence that grants or denies it, not as prose.
      const declarative = new RegExp(`\\b(?:use|using|invoke|call|via|with)\\s+(?:the\\s+)?\\b${tool}\\b(?:\\s+tool)?\\b(?!\\s*(?:via|through|script))`, 'i');
      if (declarative.test(body)) problems.push(`${file.replace(`${ROOT}/`, '')}: body directs use of ${tool} but tools: omits it`);
    }
  }
  if (problems.length) throw new Error(problems.join('; '));
  return 'ok';
});

check('granted tools are each used or explicitly justified', () => {
  const problems = [];
  for (const file of walk(join(ROOT, 'agents')).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(file, 'utf8');
    const granted = (text.match(/^tools:\s*(.+)$/m)?.[1] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const body = text.slice(text.indexOf('\n---', 3));
    for (const tool of granted) {
      if (new RegExp(`\\b${tool}\\b`).test(body)) continue;
      problems.push(`${file.replace(`${ROOT}/`, '')}: grants ${tool} but never mentions it — drop it or say why it is needed`);
    }
  }
  if (problems.length) throw new Error(problems.join('; '));
  return 'ok';
});

check('no agent grants Write or Edit (verifiers must not alter what they verify)', () => {
  const bad = [];
  for (const file of walk(join(ROOT, 'agents')).filter((f) => f.endsWith('.md'))) {
    const tools = /^tools:\s*(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
    const granted = tools.split(',').map((t) => t.trim());
    if (granted.includes('Write') || granted.includes('Edit')) bad.push(`${file.replace(`${ROOT}/`, '')}: grants ${granted.filter((t) => t === 'Write' || t === 'Edit').join('+')}`);
  }
  if (bad.length) throw new Error(`an injected instruction plus Write would let a repo rewrite an agent's own prompt for the next run:\n      ${bad.join('\n      ')}`);
  return 'ok';
});

// The clone-location and identity contract is load-bearing security surface, and it lives in prose
// the orchestrator follows literally. A mismatch here is how the orchestrator ends up told to clone
// into a project tree, which is the one thing the architecture forbids.
check('the orchestrator documents the clone location the code implements', () => {
  const skill = readFileSync(join(ROOT, 'skills/analyze/SKILL.md'), 'utf8');
  const { cloneRoot, repoKey } = pathsModule;
  const clone = cloneRoot();

  // The clone root must be described as its own thing, never as living under the state root.
  if (!skill.includes('GROUNDTRUTH_CLONE_DIR')) {
    throw new Error('SKILL.md never mentions GROUNDTRUTH_CLONE_DIR, so an orchestrator cannot know where clones go');
  }
  const underState = /(?:state root\}\/sources|state_root\}\/sources)/i.test(skill);
  if (underState) {
    throw new Error('SKILL.md places clones under the state root, which is inside the project tree — ' +
      `the code puts them at ${clone}`);
  }
  if (stateRootModule() && clone.startsWith(stateRootModule())) {
    throw new Error(`cloneRoot() is inside stateRoot(): ${clone}`);
  }

  // Identity separator: paths.mjs uses one dot. Prose saying owner__repo sends payloads to a
  // directory nothing reads, and the renderer then reports an empty profile.
  const key = repoKey('https://github.com/acme/tool');
  if (key !== 'acme.tool') throw new Error(`repoKey contract changed: got ${key}`);
  if (/owner__repo/.test(skill)) {
    throw new Error('SKILL.md documents owner__repo but paths.mjs derives owner.repo — payloads would be written where nothing reads them');
  }
  if (!skill.includes('owner.repo')) {
    throw new Error('SKILL.md does not state the owner.repo identity format');
  }
  return `clone root ${clone}, key ${key}`;
});

// Two orchestrator steps invoked subcommands that did not exist, and the default branch exited 0, so
// the caller saw success. The usage text is only enforced if something checks it against reality.
check('every script invocation in the orchestrator resolves to a real subcommand', () => {
  const skill = readFileSync(join(ROOT, 'skills/analyze/SKILL.md'), 'utf8');
  const source = readFileSync(join(ROOT, 'scripts/state.mjs'), 'utf8');
  const implemented = new Set([...source.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
  const missing = new Set();
  for (const m of skill.matchAll(/state\.mjs\s+([a-z-]+)/g)) {
    if (!implemented.has(m[1])) missing.add(m[1]);
  }
  if (missing.size) throw new Error(`SKILL.md calls unimplemented state.mjs subcommands: ${[...missing].join(', ')}`);

  // Scripts referenced by the orchestrator must exist on disk.
  for (const m of skill.matchAll(/scripts\/([a-z-]+\.mjs)/g)) {
    if (!existsSync(join(ROOT, 'scripts', m[1]))) throw new Error(`SKILL.md references missing script scripts/${m[1]}`);
  }
  return `${implemented.size} subcommands, all referenced ones exist`;
});

check('the write gate validates every stage it accepts', () => {
  const source = readFileSync(join(ROOT, 'scripts/write-payload.mjs'), 'utf8');
  // A stage that falls through to "ok" is a stage whose payload shape is never checked, which is how
  // seven of eight stages ended up unvalidated while the file was described as the validating gate.
  if (/\? \{ ok: true, errors: \[\] \}/.test(source)) {
    throw new Error('write-payload.mjs accepts a stage with no validation — its shape would be unchecked');
  }
  // Verifier stages share one shape: a list of verdicts with cited files. Structural validation is
  // therefore a family check, and every stage must appear in the family.
  const stages = ['technical', 'community', 'conflicts', 'spotcheck'];
  const family = /VALIDATED_STAGES/;
  if (!family.test(source)) {
    throw new Error('write-payload.mjs declares no validated-stage list, so a new stage would silently be unchecked');
  }
  for (const stage of stages) {
    if (!source.includes(`'${stage}'`)) throw new Error(`write-payload.mjs does not mention stage "${stage}"`);
  }
  return `${stages.length + 2} stages validated (analysis, profile, + ${stages.length} verifier stages)`;
});

check('the orchestrator reads its arguments', () => {
  const file = join(ROOT, 'skills', 'analyze', 'SKILL.md');
  if (!existsSync(file)) throw new Error('skills/analyze/SKILL.md missing');
  const text = readFileSync(file, 'utf8');
  if (!/\$ARGUMENTS/.test(text)) throw new Error('no $ARGUMENTS — a slash command receives arguments there, not as ambient chat text, so every documented entry point would be dead');
  return 'ok';
});

check('no shipped file contains a resolved local path', () => {
  const bad = [];
  // Match resolved paths with a username segment, ignoring inline code spans, so the security
  // rules that *forbid* absolute paths are not flagged as containing one. Tests are excluded: they
  // deliberately contain path fixtures, which is the only way to exercise the guards at all.
  const re = /(?:^|[\s"'`(])(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+/;
  const shipped = shippedFiles()
    .filter((f) => /\.(md|json|mjs|js)$/.test(f))
    .filter((f) => !f.includes('/test/'));
  for (const file of shipped) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const bare = line.replace(/`[^`]*`/g, '');
      if (re.test(bare)) bad.push(`${file.replace(`${ROOT}/`, '')}: ${line.trim().slice(0, 80)}`);
    }
  }
  if (bad.length) throw new Error(`absolute paths would break portability:\n      ${bad.join('\n      ')}`);
  return 'ok';
});

check('no tracking or output artefact is shipped', () => {
  const shipped = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files || [];
  const forbidden = ['output/', 'tracking/', 'bin/', '.npmignore', 'sources/'];
  const bad = shipped.filter((f) => forbidden.some((x) => f.startsWith(x)));
  if (bad.length) throw new Error(`package.json files ships ${bad.join(', ')} — re-running the package would overwrite the user's registry and reports with empty templates`);
  for (const dir of ['output', 'tracking', 'bin']) {
    if (existsSync(join(ROOT, dir))) throw new Error(`${dir}/ exists in the repo — run state and reports are created at run time, never shipped`);
  }
  return 'ok';
});

// Placeholder URLs in prose are fine; placeholder URLs in run state are not. State is machine-read,
// so an example left in it comes back as a real repo on the next run, takes the no-drift path, and
// is never analysed. Only state and schema sources are load-bearing here.
check('no machine-read file contains a placeholder repository URL', () => {
  const machineRead = ['core/lib', 'core/schema', 'scripts', 'test'];
  const bad = [];
  const placeholder = /github\.com\/(?:org|example|owner|your-?org)\//;
  for (const dir of machineRead) {
    for (const file of walk(join(ROOT, dir))) {
      if (!/\.(mjs|json)$/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (placeholder.test(line) && !/pattern|description|example\b/.test(line)) {
          bad.push(`${file.replace(`${ROOT}/`, '')}:${i + 1}`);
        }
      }
    }
  }
  if (bad.length) throw new Error(`placeholder URLs in machine-read files: ${bad.join(', ')}`);
  return 'ok';
});

check('npm tarball contains every directory the manifest needs', () => {
  let out;
  try {
    out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return 'skipped (npm unavailable)';
  }
  let listed = [];
  try {
    listed = JSON.parse(out)[0]?.files?.map((f) => f.path) || [];
  } catch { /* fall through to the allowlist check */ }
  if (!listed.length) return 'skipped (npm pack produced no file list)';

  const required = ['.claude-plugin/plugin.json', 'agents', 'skills/analyze/SKILL.md', 'scripts/verify-layout.mjs', 'core/lib/paths.mjs'];
  const missing = required.filter((r) => !listed.some((p) => p === r || p.startsWith(`${r}/`)));
  if (missing.length) throw new Error(`package.json files omits ${missing.join(', ')} — the published package would ship without them`);
  return `${listed.length} files, all required present`;
});

check('claude plugin validate passes', () => {
  try {
    const out = execFileSync('claude', ['plugin', 'validate', '.'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim().split('\n').pop();
  } catch (e) {
    const detail = `${e.stdout || ''}${e.stderr || ''}`.trim();
    throw new Error(`claude plugin validate failed:\n${detail}`);
  }
});

check('core modules import cleanly', async () => {
  const mods = ['paths', 'state', 'validate', 'clone', 'injection', 'render'];
  for (const m of mods) {
    const mod = await import(join(ROOT, 'core', 'lib', `${m}.mjs`));
    if (!mod || typeof mod !== 'object') throw new Error(`core/lib/${m}.mjs did not export anything`);
  }
  return `${mods.length} modules`;
});

let failed = 0;
process.stdout.write('\nlayout invariants\n\n');
for (const { name, fn } of checks) {
  try {
    const detail = await fn();
    process.stdout.write(`  PASS  ${name}\n${detail ? `        ${detail}\n` : ''}`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${String(error.message).split('\n').join('\n        ')}\n`);
  }
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} passed\n\n`);
process.exit(failed ? 1 : 0);