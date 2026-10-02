# Groundtruth — working on this repository

Process contract for AI agents and humans. Follow it for **every** change.

## What this is

A pipeline that clones GitHub repositories and adjudicates their claims against implementation code.
You give it URLs; it produces a report where every claim carries an evidence tier, a file citation,
and — when nothing could settle it — an explicit "uncovered" count.

The product is the **registry**: a persistent, drift-gated record of what is actually true about a
set of repositories, re-checked only where the commit changed. Everything else serves that.

## Read these before designing anything

1. [SECURITY.md](SECURITY.md) — threat model, and what is **not** defended. Non-negotiable context.
2. [docs/design-decisions.md](docs/design-decisions.md) — ratified decisions. If a change contradicts
   one, the entry wins until it is amended.

## Hard constraints

- **Repositories are hostile input.** Never weaken a guard to make a pipeline stage easier. If a new
  agent needs a tool it does not currently have, that is a decision entry, not a one-line edit.
- **No agent holds `Write` or `Edit`.** All nine write through `scripts/write-payload.mjs`, which
  validates before accepting. Granting `Write` reintroduces self-escalation: an injected agent would
  rewrite the pipeline for the next run. Note the limit honestly: an agent that holds `Bash` can still
  write a file, so withholding `Write` removes the direct path and not the capability.
  `SECURITY.md` says so, and `meta-reconciler` is the one agent that needs the shell.
- **Clones stay outside the project tree.** A repository inside a project is loaded as project
  configuration the moment an agent reads a file in it. `core/lib/paths.mjs` keeps the two roots
  separate; there is a test asserting it.
- **Clones are read-only.** Drift uses `git ls-remote`, never `git pull`. A pull runs against an
  untrusted remote with the user's real Git identity.
- **The renderer is the only writer of the report.** Models emit `profile.json`; `render.mjs` writes
  markdown. Two writers over one file is the corruption this design exists to prevent, and it is why
  cross-repo sections come from a deterministic synthesizer rather than a second model pass.
- **A verdict must cite a file that exists in the clone.** Never weaken `core/lib/validate.mjs` to
  accommodate a payload.
- **Zero runtime dependencies.** The package ships none. `npm audit` is therefore a no-op and must not
  be cited as a control.
- **Source state is aliases; installed state is resolved IDs.** `model:` in frontmatter is static
  text read at spawn time — no script can change it at runtime.

## Quality gates

```bash
npm run verify        # everything below; the gate
npm run verify:layout # layout and packaging invariants
npm run verify:frontmatter
npm test
```

`npm run verify` must pass before a change is done. **Layout invariants are not optional** — see
below.

## Why layout tests are mandatory

This project's first version shipped with nine agents and one orchestrator that no harness could
discover, because the install target was a directory Claude Code never scans. Nothing failed, because
nothing checked. Three separate fatal bugs, each individually sufficient to make the tool
non-functional.

`scripts/verify-layout.mjs` now asserts each of them, plus: agent names that would resolve
double-prefixed under plugin scoping, `SKILL.md` without frontmatter, a `package.json` `files`
allowlist that would ship a plugin without its manifest, tools named in a prompt but not granted,
`Write` granted to any agent, and placeholder URLs in machine-read files.

If you add an agent, a skill, or a script, **extend this file in the same commit.** A new component
with no invariant is how the next version ships broken.

Three invariants exist specifically because a check once looked implemented and never ran: the
orchestrator's documented clone location is asserted against `paths.mjs`, its CLI invocations are
asserted against the implemented subcommands, and every stage `write-payload.mjs` accepts is asserted
to be validated. A stage that falls through to "ok" is a stage whose shape is unchecked.

## The artifact matrix

| Change type | Tests | Invariant | CHANGELOG | Decision entry |
|---|---|---|---|---|
| New agent or skill | ✅ | ✅ both | ✅ | ✅ **required** |
| Validator or guard change | ✅ including an evasion attempt | ✅ | ✅ | ✅ **required** |
| Schema change | ✅ migration test | ✅ | ✅ | ✅ **required** |
| Pipeline stage change | ✅ | ✅ if layout moved | ✅ | ✅ **required** |
| Renderer change | ✅ golden output | — | ✅ | ❌ unless output shape changed |
| Dependency manifest bug | ✅ | ✅ | ✅ | ❌ unless the fix reveals the wrong decision |
| Refactor, no observable change | existing must pass | ✅ if layout moved | optional | ❌ |
| Docs only | ❌ | — | optional | only when changing a decision |

**Tiebreaker:** could a user observe the difference? If yes → CHANGELOG. If no → neither. Do not
write decision entries for typo fixes; never skip one for new semantics.

## Adding an agent

The template is `agents/spot-checker.md` — small, bounded, and easy to read. Requirements:

- `tools` grants only what the body actually uses. An unused grant is both a bigger blast radius and
  a verification failure.
- Every tool *named* in the body must be granted, and vice versa. `verify-layout.mjs` checks both
  directions.
- `model` is a tier alias: `haiku`, `sonnet`, or `opus`. See `config/models.json`.
- `maxTurns` only if the agent genuinely needs headroom — and note that truncation is silent below
  client v2.1.246, which is the same failure class as the fake-resume bug.
- `omitClaudeMd: true`, always. It stops the host loading a clone's instruction files.
- Name it **without** the `groundtruth-` prefix. The plugin namespace applies it.
- The body must state the agent's evidence surface and what it must not read. Overlapping surfaces
  are what make verifier agreement meaningless.
- If it reads attacker-controlled content, include the untrusted-content preamble and say where its
  detections get recorded.

## Adding a pipeline stage

A stage is only correct if its **output is persisted**, not just its status. The original design
recorded ✅ for work whose payload existed only in a dying context window, so resume skipped analysis
that had never run — a success marker over a total miss. Any new stage writes through
`write-payload.mjs` and declares its schema.

## Verification discipline

When adding a security guard, write the test with the shapes that **defeat a naive implementation**:
tilde expansion, unquoted paths, loosely written flags, symlinked roots, alternate interpreters,
and shell-specific redirection. Several guards in `guard-bash.mjs` have a comment recording the exact
attack that defeated the previous revision, because the obvious pattern silently passed.

Assert on behaviour, not on implementation. Tests that reach into a module's internals pass right up
until the thing they were protecting is rewritten.

## Commits

- Conventional commits: `feat(scope):`, `fix(scope):`, `docs(scope):`, `test(scope):`, `chore(scope):`, `ci:`
- Scopes: `dist`, `state`, `security`, `models`, `render`, `hooks`, `agents`, `docs`, `ci`, `repo`
- One logical change per commit, carrying all its artifacts from the matrix. A commit should be
  revertable as a unit.
- The body explains **why**, not what — the diff shows what. Record the attack or failure mode that
  motivated a fix; that is the part a future reader cannot reconstruct.
- Never hard-wrap the body. One item per line, however long.
- No model names or tool signatures in commit messages or code.

## Dependencies

Zero runtime dependencies, and that is a deliberate constraint rather than an accident: this tool
reads untrusted repositories and hands the results to models, so its own supply chain is a
first-order risk. Every dependency is also a way in.

Adding one requires a decision entry explaining what it buys and why the standard library or the
~600 lines of `core/` will not do.

## Before publishing

- `npm run verify` green
- `claude plugin validate .` clean
- `npm pack --dry-run` lists every directory the manifest references
- Version bumped in both `package.json` and `.claude-plugin/plugin.json` — CI asserts they match
- `CHANGELOG.md` updated
- `EVALUATION.md` updated if any tier logic or prompt changed
- Confirmed by an empirical probe, not only by reading docs: a scratch copy of the plugin, loaded with
  `--plugin-dir`, actually registering every agent and resolving every command. This is how the
  double-prefixing and dead-command bugs were found, and reading documentation did not catch them.