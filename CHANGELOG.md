# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-06

### Added

- **Claim quotations are verified against the file they cite**, on the `profile` rather than on the
  intermediate analysis payload. A claim now requires `quote` and `source`, and the quotation must occur
  in the cited file within three lines of the line it cites. Transcription tolerance is preserved for
  line wrapping and typographic quotes, because an agent reproducing a rendered Markdown file
  legitimately loses both.
The gate was previously on the wrong artifact: `analysis.json` quotes were checked, and
`analysis.json` quotes are never rendered. The gap was found by hand-writing impossible claims for
`cloudflare/security-audit-skill` — including a paraphrase of a claim believed to be genuine — and
watching every check pass and the claims reach a report.
An adversarial review of the first version of this check found it defeatable in ways that made it
theatre, and each bypass is now a regression test:
- A one-character quote matched every line of a prose file, so `text: "audited by a third party"` with
  `quote: "e"` passed. Quotes must now span at least two words and eight non-space characters.
- A non-string `source.path` returned without recording an error, so the claim passed with zero errors
  — the project's own recurring failure class in a new place. Every path now fails closed.
- A quote padded with 300 newlines reached a 1002-line positional tolerance, which is not a citation.
  The span is counted from non-blank lines and capped.
- The `exact` matching rule joined lines with a space, so it was not exact.
- The repo key became the containment root for every cited file while arriving unchecked on argv.
`test/quote.test.mjs` adds 31 cases including all six regressions.
**Breaking:** profiles written before this change no longer validate. They must be rebuilt from their
analysis payloads rather than patched — the reconciler now carries each quotation into its profile
claim. This is deliberate: a profile that cannot show the text it was verified against is exactly the
artifact this product exists to stop publishing.
- `EVALUATION.md` records the live runs, the four defects, and one negative result: claim quotations are
  not verified against their cited file. `validateClaimFile` checks that a claim is well formed and
  cites an existing file, but a hallucinated quote passes. This is a validator gap and the largest
  known hole in the product.
The pipeline had never run. This release makes it work, and makes it trustworthy while it runs.
- `scripts/verify-layout.mjs` — 23 layout and packaging invariants, including the clone-location
  contract, the orchestrator's CLI surface, per-stage write validation, and a check that every npm
  script resolves to a script that does real work. This is the file whose absence
  let three separately fatal bugs ship; a new agent, skill, or script must extend it in the same
  commit.
- 117 tests with no dependencies, covering a hostile-repository fixture, citation provenance
  (existence, containment, per-agent read log, correlation by canonical path), credential exfiltration,
  and the command shapes that defeated earlier revisions of the guards.
- `report.provenance.json` in W3C PROV-O shape, so every tier can be audited mechanically instead of
  trusted; contradictions are recorded as `invalidated`.
- `llms.txt` alongside the report.
- `scripts/install-guardrails.mjs` for the permission and sandbox settings a plugin cannot ship.
- `config/models.json` with three tiers and environment overrides.
- `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/design-decisions.md`, and `CHANGELOG.md`.

### Changed

- **Relicensed from MIT to Apache-2.0**, matching the other four repositories in the `fyrlabs` org
  (`dead-drop`, `dead-drop-shell`, `mcp-docs`, `mcp-nexus`), which are all Apache-2.0. `LICENSE` is the
  verbatim Apache 2.0 text with the appendix filled in as `Copyright 2026 fyrlabs`, `NOTICE`
  follows the org's existing shape, and the README points at the licence file rather than naming it
  inline. The holder is spelled `fyrlabs`, matching the org, the npm scope and the plugin author; the
  org's own repositories are inconsistent here (`dead-drop` writes `Fyr Labs`, `mcp-nexus` writes
  `Fyrlabs`), which is why the spelling is asserted nowhere rather than left to drift again.
- **Dropped the `author` field from `package.json`.** Three of the four sibling packages omit it; the
  one that declares it uses a personal name. The org is the attribution, recorded in `NOTICE`.
  `plugin.json` keeps `author` because a plugin listing needs a visible owner and the org has no
  sibling plugin to copy from.
- `verify-layout.mjs` asserts that `LICENSE`, `package.json`, `plugin.json` and `marketplace.json` all
  declare the same licence, that the declaration matches the text in `LICENSE`, and that a declared
  Apache-2.0 actually ships a `NOTICE`. The licence previously lived in four places that no check
  connected, so any one of them could be edited alone while every gate passed.
Relicensing applies forward. `@fyrlabs/groundtruth@0.2.0` has never been published, so no grant under
the new identity has been issued; `@sathvikc/groundtruth@0.1.0` was published under MIT and those
recipients keep their MIT rights permanently, since MIT is irrevocable.
- **Repositories with harness control files are now analysed rather than refused.** `CLAUDE.md`,
  `AGENTS.md`, `.claude/` and siblings are quarantined outside the clone and disclosed in the run log.
  The refusal was a leftover from when clones sat inside the project tree; it now excluded most of the
  ecosystem worth analysing, since `hermes-agent` ships twelve `AGENTS.md` files and
  `cloudflare/security-audit-skill` ships its own. A first live run against trending repositories hit it
  immediately. Only size, depth, and file-count overruns still refuse.
- **The quarantine store was inside the project tree.** It sat under the state root, which defaults to
  `<project>/.claude/groundtruth` — inside the working directory, where the harness loads `CLAUDE.md`
  from subdirectories once an agent reads a file there. The commit that moved clones out of the project
  to prevent exactly this then put quarantined `CLAUDE.md` files one function away. Now a sibling of
  the clone root, with a read guard and a test asserting the separation.
- **`.claude/` was still refused, not quarantined**, so the headline feature did not work for the
  highest-value injection targets — `.claude/skills/**` and `.claude/agents/*` are both auto-loaded.
  The commit quarantined the harmless names and kept refusing the dangerous one.
- **Every second clone call failed and deleted the clone.** The reuse branch was dropped, so a repeat
  call fell through to `git clone` into a non-empty directory, git refused, and the error handler
  removed the tree. Revisit is the core product loop.
- **The refusal marker was attacker-plantable** (it lived inside the clone, which the remote controls)
  and an unreadable one crashed the stage on every revisit. Moved outside the clone and parsed
  defensively.
- **A symlink named `CLAUDE.md` produced no finding at all** and stayed in the clone.
- **The "same source cited by all agents" sentence was false for partial overlap** — schema, validator,
  and renderer disagreed. The validator now records the shared paths and the renderer states them.
- **A non-GitHub URL crashed the clone script** on an out-of-scope variable instead of reporting.
- **The frontmatter linter no-oped under a checkout path that was a symlink or contained a space** —
  byte-for-byte the bug it had just been written to fix. `import.meta.url` is resolved and
  percent-encoded; `process.argv[1]` is neither.
- **The "stub script" invariant was unsatisfiable**, requiring a literal to be both present and absent.
  Dead code in the fix for dead code.
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

### Fixed

Four defects that only a live run against a real repository could surface. All four produced a
pipeline that reported success over missing or repeated work.
- A partial working tree was reused as if intact. An interrupted `git clone` leaves a valid `.git` and
  a resolvable `HEAD` while most of the checkout is absent; reuse accepted it, and a live run analysed
  a one-file fragment of a twenty-two-file repository. Reuse now requires `git ls-files --deleted` to
  agree with the manifest's quarantine count.
- Debris at a clone path with no `.git` made every later run fail permanently with git's "destination
  path already exists and is not an empty directory", then write a refusal marker nothing in the
  pipeline could clear. A clone is derived from a URL, so an unusable directory at the target is now
  removed before cloning.
- `write-payload.mjs --file` treated its argument as an output path as well as an input, so a payload
  could be written outside the state directory where no resume could find it. `--file` is now input
  only; every write lands in state. `write-profile.mjs` was rewritten to match, and the reconciler
  prompt no longer validates a path it does not own.
- The resumable stage list named the reconciler stage `reconcile` while every write path used
  `profile`. Nothing ever wrote `reconcile`, so `repoProgress` never counted a finished repository
  complete and every resume redid the most expensive stage in the pipeline. `scripts/verify-layout.mjs`
  now asserts the two name sets agree.
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
Found by an adversarial review of the first draft of 0.2.0, and fixed before release. Each was a
control that appeared to exist and did not. A second review, run against the first round of fixes,
found more of the same class — all in controls added days earlier:
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
- **The documented model overrides did nothing.** README advertised `GROUNDTRUTH_MODEL_*`, but
  `model:` in agent frontmatter is static text read at spawn time — no script or settings key can
  change it — so an installed plugin ignored the variable entirely. The orchestrator now resolves the
  tiers at Step 0 and passes each tier's model on the `Task` dispatch, which is the only mechanism
  that works. The resolution is recorded in state and surfaces in `report.provenance.json`, so a
  published profile can name the model behind each claim.

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
  `@fyrlabs`. Copyright to fyrlabs and Groundtruth contributors — as shipped in this release,
  which is MIT-licensed. The project was relicensed to Apache-2.0 in a later release; see
  [Unreleased].
- Git history is unchanged: the original commits remain attributed to their author. Rewriting
  attribution in a project about provenance would be self-defeating.
[Unreleased]: https://github.com/fyrlabs/groundtruth/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/fyrlabs/groundtruth/releases/tag/v0.2.0
