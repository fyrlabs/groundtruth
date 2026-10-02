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

### Fixed

Found by an adversarial review of the first draft of 0.2.0, and fixed before release. Each was a
control that appeared to exist and did not:

- **`npm run verify:frontmatter` was a no-op.** `lint-frontmatter.mjs` exported a `run()` function and
  never called it, so it exited 0 forever — including while the repository contained two deliberate
  violations. A linter that cannot fail is worse than no linter, because it manufactures confidence.
  Now self-invoking, with a test that plants a violation and asserts a non-zero exit, and a layout
  invariant that catches the whole class for every npm script.

- **The citation-provenance check was reading a log nothing wrote.** `validate.mjs` had the plumbing
  for verifying that an agent read the file it cited, and no writer anywhere — so it was dead code, and
  the central claim of the release rested on it. The `PostToolUse` hook now records each read, and the
  validator requires a citation to appear in *that agent's* log, failing closed when no log exists.
- **A cited path could be a directory or an escaping symlink.** `existsSync` is true for directories,
  and `resolve` is purely lexical, so a symlink inside the clone pointing at `/etc/passwd` satisfied
  the containment test. Now: regular file, realpath inside the root, `.git` not citable.
- **The correlation rule compared path strings.** `README.md` and `readme.MD` are one file on a
  case-insensitive volume, so a model varying capitalisation defeated it. Now compares canonical paths.
- **Clone refusals reported the wrong file.** `relative()` was called against a bare entry name, so a
  refusal pointed at a same-named file elsewhere on the machine. The refusal worked; its evidence did not.
- **The orchestrator was told to clone into the project tree.** `SKILL.md` documented
  `<state root>/sources`, which is inside the project — the one thing the architecture forbids — and
  used `owner__repo` where the code derives `owner.repo`. Three new layout invariants assert both
  contracts against the implementation.
- **Two orchestrator steps were dead.** `state.mjs registry` and `state.mjs finish` did not exist, and
  the unknown-subcommand branch exited 0, so the caller saw success. Added, along with
  `record-manifest`, and the default branch now exits non-zero.
- **The drift stage was a permanent no-op.** `drift.mjs` read a `manifest.json` that nothing wrote, so
  it skipped every repository. `clone.mjs` now records the SHA and version it analysed.
- **Six of seven payload stages were unvalidated.** `write-payload.mjs` fell through to "ok" for
  everything but `profile` and `analysis`, while the file described itself as the validating gate.
- **The scrubber corrupted legitimate config files.** The role-spoof pattern consumed a character past
  the colon, so `user: admin` in a YAML file was rewritten. Anchored to instruction-shaped
  continuations instead, with emphasis and chained roles still detected.
- **Every quarantine marker pointed at end-of-file.** `hit[0].index` is `String.prototype.index`, a
  search method — it was `undefined`. Now `hit.index`, and every span in a run is recorded rather
  than one per pattern.
- **A file of zero-width characters expanded 68x on the way out**, turning the clone size cap into a
  token-exhaustion vector. Runs now collapse to one marker.
- **The renderer stamped `new Date()` internally**, so the report header and provenance file differed on
  every run, while the test claiming purity covered only the one function without a timestamp. The
  clock is now injected, digit grouping is locale-independent, and the test covers `renderReport`.
- **A path containing a space disabled the whole write guard**, because the plugin root was derived
  from `URL.pathname` instead of `fileURLToPath`.
- **`process.env.HOME` was denied as a "dotenv file"** — the `.env` pattern matched the property access.

### Changed

- **Repositories with harness control files are now analysed rather than refused.** `CLAUDE.md`,
  `AGENTS.md`, `.claude/` and siblings are quarantined outside the clone and disclosed in the run log.
  The refusal was a leftover from when clones sat inside the project tree; it now excluded most of the
  ecosystem worth analysing, since `hermes-agent` ships twelve `AGENTS.md` files and
  `cloudflare/security-audit-skill` ships its own. A first live run against trending repositories hit it
  immediately. Only size, depth, and file-count overruns still refuse.
- **Correlated agreement must be disclosed, no longer blocks the tier.** The first live run surfaced
  this as wrong: on a licence claim, two agents applied different arguments to one file and the rule
  forced a downgrade of a verified fact. `code-verified` answers "was this confirmed by reading the
  file"; independence is a separate question recorded in `correlated`. Undisclosed same-source agreement
  is still rejected.
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

### Fixed

- **The documented model overrides did nothing.** README advertised `GROUNDTRUTH_MODEL_*`, but
  `model:` in agent frontmatter is static text read at spawn time — no script or settings key can
  change it — so an installed plugin ignored the variable entirely. The orchestrator now resolves the
  tiers at Step 0 and passes each tier's model on the `Task` dispatch, which is the only mechanism
  that works. The resolution is recorded in state and surfaces in `report.provenance.json`, so a
  published profile can name the model behind each claim.

### Added

- `scripts/verify-layout.mjs` — 23 layout and packaging invariants, including the clone-location
  contract, the orchestrator's CLI surface, per-stage write validation, and a check that every npm
  script resolves to a script that does real work. This is the file whose absence
  let three separately fatal bugs ship; a new agent, skill, or script must extend it in the same
  commit.
- 106 tests with no dependencies, covering a hostile-repository fixture, citation provenance
  (existence, containment, per-agent read log, correlation by canonical path), credential exfiltration,
  and the command shapes that defeated earlier revisions of the guards.
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