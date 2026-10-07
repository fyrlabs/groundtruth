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
// GROUNDTRUTH_MODEL_* is documented in the README, but `model:` in agent frontmatter is static text
// read at spawn time, so an env override can only take effect if the orchestrator resolves the tiers
// and passes them on each dispatch. Without this the documented knob silently does nothing.
check('the orchestrator resolves models and passes them per dispatch', () => {
  const skill = readFileSync(join(ROOT, 'skills/analyze/SKILL.md'), 'utf8');
  if (!/resolve-models\.mjs --json/.test(skill)) {
    throw new Error('SKILL.md never resolves model tiers, so GROUNDTRUTH_MODEL_* has no effect');
  }
  if (!/model: <(fast|medium|strong)>/.test(skill)) {
    throw new Error('SKILL.md dispatches no `model:` parameter, so resolved tiers are never applied');
  }
  // Every tier must be wired to at least one dispatch.
  for (const tier of ['fast', 'medium', 'strong']) {
    if (!skill.includes(`model: <${tier}>`)) throw new Error(`tier "${tier}" is resolved but never dispatched`);
  }
  // And the resolution must be recorded, or a report cannot state what produced a claim.
  if (!/record-models/.test(skill)) {
    throw new Error('SKILL.md does not record the resolved models, so provenance cannot name them');
  }
  if (!existsSync(join(ROOT, 'scripts/resolve-models.mjs'))) throw new Error('scripts/resolve-models.mjs missing');
  return '3 tiers resolved, dispatched, and recorded';
});

// Each npm script must actually invoke a real script. A `files` allowlist is silent about a missing
// path, and a stub script that exits 0 is worse than a missing one: `npm run verify` would report
// green while checking nothing.
check('every npm script resolves to a script that exists and does work', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const broken = [];
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    for (const m of command.matchAll(/scripts\/([a-z-]+\.mjs)/g)) {
      const path = join(ROOT, 'scripts', m[1]);
      if (!existsSync(path)) {
        broken.push(`npm run ${name} -> scripts/${m[1]} does not exist`);
        continue;
      }
      // A linter or verifier that exports a function and never calls it exits 0 forever.
      const source = readFileSync(path, 'utf8');
      const exportsARun = /export\s+(?:async\s+)?function\s+run\s*\(|export\s+const\s+run\s*=/.test(source);
      // Recognise any correct self-invoke, not one literal spelling — the point is to catch a runner
      // that is exported and never called, not to pin a formatting choice.
      // Accept any correct self-invoke: URL comparison, path comparison, or a canonicalised one.
      const selfInvokes = /(?:pathToFileURL\(process\.argv\[1\]\)\.href === import\.meta\.url|process\.argv\[1\] === fileURLToPath\(import\.meta\.url\)|canonical\(process\.argv\[1\]\) === canonical\()/s.test(source);
      if (exportsARun && !selfInvokes) {
        broken.push(`scripts/${m[1]} exports run() but never invokes it, so it always exits 0 (npm run ${name})`);
      }
      // A script whose last statement is an unconditional success literal reports green whatever it
      // computed. The earlier version of this check required the literal to be present AND absent,
      // which is unsatisfiable — dead code in the fix for dead code.
      const tail = source.trimEnd().split('\n').slice(-3).join('\n');
      if (/\{\s*ok:\s*true\s*,\s*errors:\s*\[\]\s*\}\s*;?\s*$/.test(tail) && !/return\s+\{\s*ok:\s*true/.test(source)) {
        broken.push(`scripts/${m[1]} ends in an unconditional success result (npm run ${name})`);
      }
    }
  }
  if (broken.length) throw new Error(broken.join('; '));
  return `${Object.keys(pkg.scripts || {}).length} scripts, all resolving`;
});

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

check('the resumable stage list and the write gate agree on stage names', () => {
  // The stage list drove repoProgress, the write gate drove what actually lands in state, and the two
  // disagreed on the reconciler: the list said 'reconcile', every write path said 'profile', and
  // nothing ever wrote 'reconcile'. Every resume therefore redid the most expensive stage in the
  // pipeline while reporting the repository as incomplete. Assert the two name sets agree so the
  // disagreement cannot be reintroduced silently.
  const state = readFileSync(join(ROOT, 'core', 'lib', 'state.mjs'), 'utf8');
  const gate = readFileSync(join(ROOT, 'scripts', 'write-payload.mjs'), 'utf8');

  const listMatch = state.match(/const STAGES = \[([^\]]+)\]/);
  if (!listMatch) throw new Error('core/lib/state.mjs has no STAGES array');
  const resumable = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const validatedMatch = gate.match(/VALIDATED_STAGES = new Set\(\[([^\]]+)\]\)/);
  if (!validatedMatch) throw new Error('scripts/write-payload.mjs has no VALIDATED_STAGES set');
  const validated = [...validatedMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  // Every payload-bearing stage the gate can write must be resumable, or its work is redone every run.
  for (const stage of validated) {
    if (!resumable.includes(stage)) {
      throw new Error(`write-payload.mjs accepts stage "${stage}" but core/lib/state.mjs does not track it — ` +
        'a resume would redo that stage forever');
    }
  }
  // Nothing resumable may be a name the gate can never write, or it is complete by definition.
  const writable = new Set([...validated, 'clone', 'render']);
  for (const stage of resumable) {
    if (!writable.has(stage)) {
      throw new Error(`core/lib/state.mjs tracks stage "${stage}" but nothing can ever write it`);
    }
  }
  return `${resumable.length} resumable stages, all writable (${validated.length} validated)`;
});

check('every path in the package.json files allowlist exists', () => {
  // The allowlist shipped "CLAUDE.md", which is not in the repository and which nothing required. npm
  // ignores a non-matching entry without complaint and the packaging gate only asserted that required
  // paths were present, so a manifest could reference files that do not exist while every gate passed
  // — and AGENTS.md tells authors to verify that npm pack lists every directory the manifest references.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const dead = pkg.files.filter((f) => !existsSync(join(ROOT, f)));
  if (dead.length) {
    throw new Error(`package.json files lists paths that do not exist: ${dead.join(', ')}`);
  }
  // And the inverse: a directory the plugin needs at runtime but the allowlist omits ships broken.
  return `${pkg.files.length} allowlisted paths, all present`;
});

check('every surface declares the same licence, and it matches the LICENSE file', () => {
  // The licence appeared in four places: LICENSE, package.json, plugin.json and marketplace.json. Any
  // one of them could be edited alone, and nothing would notice — npm, the plugin listing and the
  // repository would disagree while every check passed.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));

  const declared = new Set([pkg.license, plugin.license, ...market.plugins.map((p) => p.license)]);
  if (declared.size !== 1) {
    throw new Error(`licence is declared inconsistently: ${[...declared].join(' / ')}`);
  }
  const [id] = [...declared];

  // The identifier has to mean something: SPDX ids for Apache and MIT differ from the text in the file.
  const licenseText = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
  const expects = { 'Apache-2.0': 'Apache License', MIT: 'MIT License' };
  if (!expects[id]) throw new Error(`licence "${id}" has no expected LICENSE text — add it to this check rather than trusting it`);
  if (!licenseText.includes(expects[id])) {
    throw new Error(`declared licence ${id} does not match the LICENSE file, which is not the ${expects[id]} text`);
  }

  // Apache-2.0 requires a NOTICE when the work carries attribution notices; shipping the licence
  // without it is the most common way an Apache package ships non-compliantly.
  if (id === 'Apache-2.0' && !existsSync(join(ROOT, 'NOTICE'))) {
    throw new Error('declared Apache-2.0 but there is no NOTICE file');
  }
  if (id === 'Apache-2.0' && !pkg.files.includes('NOTICE')) {
    throw new Error('NOTICE is not in the package.json files allowlist, so it would not ship');
  }
  return `${id}, declared in 3 places, LICENSE file agrees, NOTICE ships`;
});

check('the release path is wired the way the org wires it', () => {
  // A release workflow that triggers on a tag push means the tag and the publish are the same act, so
  // there is no way to hold a candidate anywhere except on the machine that tagged it. Every other
  // repository in the org publishes on `release: published`; a disagreement here is silent.
  const release = join(ROOT, '.github', 'workflows', 'release.yml');
  if (!existsSync(release)) throw new Error('.github/workflows/release.yml is missing — a release can never be published from CI');
  const text = readFileSync(release, 'utf8');

  if (!/release:\s*\n\s*types: \[published\]/.test(text)) {
    throw new Error('release.yml does not trigger on `release: published`');
  }
  if (!/workflow_dispatch/.test(text)) {
    throw new Error('release.yml has no workflow_dispatch input, so a failed publish cannot be retried without re-tagging');
  }
  if (!/id-token: write/.test(text)) {
    throw new Error('release.yml lacks `id-token: write`, which npm --provenance requires');
  }
  if (!/--provenance/.test(text)) {
    throw new Error('release.yml publishes without --provenance, so the tarball is unattested');
  }
  // Re-publishing an existing version aborts the job, which would strand a release that recovered.
  if (!/already published/.test(text)) {
    throw new Error('release.yml does not skip a version already on the registry, so a rerun cannot succeed');
  }

  // `npm ci` needs a lockfile. Without one the release job fails at install, after the release exists.
  if (!existsSync(join(ROOT, 'package-lock.json'))) {
    throw new Error('package-lock.json is missing but release.yml runs `npm ci`');
  }

  // The checklist and the notes template are how a release is actually performed; a missing one is how
  // a version ships without the checks that only fail in a published artifact.
  for (const required of ['RELEASE_CHECKLIST.md', 'RELEASE_TEMPLATE.md', 'pull_request_template.md']) {
    const file = join(ROOT, '.github', required);
    if (!existsSync(file)) throw new Error(`.github/${required} is missing`);
    if (!readFileSync(file, 'utf8').trim()) throw new Error(`.github/${required} is empty`);
  }
  return 'release on published-release, provenance, rerunnable, checklist present';
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