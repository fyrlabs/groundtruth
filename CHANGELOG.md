# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-10-01

The pipeline had never run. This release makes it work, and makes it trustworthy while it runs.

### Fixed

- **The pipeline was undiscoverable.** All nine agents and the one orchestrator were installed to a
  directory the host never scans, so none of them could be invoked. Every documented entry point was
  dead. Now shipped as a plugin, verified by an empirical probe rather than by reading docs.
- **`/analyze` did not exist.** Command discovery roots are project-level, not skill-level; the
  orchestrator now ships as a skill.
- **The orchestrator read no arguments.** `$ARGUMENTS` was never referenced, so
  `/analyze <url>` and the urls.txt form could not have worked even after the discovery bugs were
  fixed.
- **The skill had no frontmatter**, so its description degraded to the literal word "Groundtruth" and
  model-invocation could never trigger it.
- **Every agent name resolved double-prefixed.** `groundtruth-analyzer` became
  `groundtruth:groundtruth-analyzer`, so all eleven `Task` references named agents that did not exist.
- **The npx update path destroyed user data.** Re-running the installer copied empty templates over
  the registry and every completed profile, with no backup.
- **Repo identity collided.** Clones were keyed on the bare repo name, so `acme/tool` and
  `other/tool` shared one directory and the profile was attributed to whichever finished last.
- **Two agents referenced inputs they were never given**, one named a tool it did not have, and one
  invented a fifth confidence tier with no mapping into the report.
- **Drift detection read a CHANGELOG with an LLM** and treated a failed `git pull` as grounds for full
  re-analysis. Now compares commit SHAs read-only, with an explicit `UNKNOWN_DRIFT` that escalates
  instead of guessing.

### Changed

- Resumability is now real. State is versioned JSON with agent payloads beside their stage markers,
  written atomically. A stage counts as complete only if its payload exists — the previous design
  recorded ✅ for work whose output lived only in a dying context window, which is precisely the
  failure the feature promised to survive.
- The report is rendered from `profile.json` by a script rather than appended to by a model. One
  writer, byte-identical re-renders, and interrupted runs are recoverable.
- Models are declared as tier aliases and resolved before dispatch. Full model IDs were both
  provider-specific and stale.
- Cross-repo synthesis is deterministic, replacing a second model pass that rewrote the whole report.

### Security

Repositories are now treated as hostile input throughout.

- **Clones live outside the project tree.** The host loads `CLAUDE.md`, `AGENTS.md`, and
  `.claude/skills/**` from any directory an agent reads in, so a clone inside the project could
  install its own instructions and pre-approve its own tools. Removing the instruction to read
  `AGENTS.md` accomplished nothing on its own.
- **Repositories shipping harness control files are refused**, along with anything over the size,
  depth, file-count, or symlink-escape caps.
- **No agent holds `Write` or `Edit`.** An injected agent could otherwise rewrite the pipeline's own
  agents, guards, or settings and skip injecting anything on the next run.
- **Output-format forgery is structurally defeated.** A README containing a block shaped like
  Groundtruth's own output is data shaped like output, not an instruction, so no preamble catches it.
  Agents now emit JSON, and a verdict is accepted only if it cites a file that exists in the clone
  and that agent read. The same rule defeats hallucinated confirmations.
- **Correlated verifier agreement is discounted.** Verifiers were sharing one input and one model
  family, making them one verifier run three times; their agreement was reported as independent
  confirmation. They now have disjoint evidence surfaces, and agreement from a shared file is marked
  and disclosed.
- **Git operations are read-only.** Drift used `git pull` against untrusted remotes with the user's
  real Git identity.
- New guards for fetch-and-execute, credential reads, clone mutation, and writes to harness
  configuration including Groundtruth's own installed copy.
- New `SECURITY.md` stating what is **not** defended, including that `WebFetch` exfiltration cannot be
  contained by any shipped configuration.

### Added

- `scripts/verify-layout.mjs` — 18 layout and packaging invariants. This is the file whose absence
  let three separately fatal bugs ship; a new agent, skill, or script must extend it in the same
  commit.
- 75 tests with no dependencies, including a hostile-repository suite covering output forgery,
  credential exfiltration, traversal citations, and the command shapes that defeated earlier
  revisions of the guards.
- `report.provenance.json` in W3C PROV-O shape, so every tier can be audited mechanically instead of
  trusted; contradictions are recorded as `invalidated`.
- `llms.txt` alongside the report.
- `scripts/install-guardrails.mjs` for the permission and sandbox settings a plugin cannot ship.
- `config/models.json` with three tiers and environment overrides.
- `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/design-decisions.md`, and `CHANGELOG.md`.

### Removed

- `bin/install.js` and the `bin` field. A second distribution path under the same name meant
  Claude Code silently dropped one of them, and it was the mechanism behind the data-loss bug above.
- `commands/analyze.md`, superseded by the skill of the same purpose.
- Shipped `output/` and `tracking/` templates. Run state is created on first run, never shipped.
- `PIPELINE_STATE.md`, `REGISTRY.md`, `WATCH_LIST.md` — hand-edited prose with no schema, replaced by
  structured JSON. A placeholder URL left in a comment was enough to make the next run treat a
  fictional repository as already analysed.

### Changed identity

- Moved from `sathvikc/ground-truth` to **`fyrlabs/groundtruth`**. npm scope `@sathvikc` →
  `@fyrlabs`. Copyright to fyrlabs and Groundtruth contributors.
- Git history is unchanged: the original commits remain attributed to their author. Rewriting
  attribution in a project about provenance would be self-defeating.

[Unreleased]: https://github.com/fyrlabs/groundtruth/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/fyrlabs/groundtruth/releases/tag/v0.2.0