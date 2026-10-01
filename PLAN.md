# Groundtruth v0.2 — Review Findings & Remediation Plan

**Method:** line-by-line read of all 23 tracked files · empirical install/discovery probes ·
official Claude Code docs verification · competitive-landscape research · two adversarial reviews,
every blocking claim in which I re-verified myself (three reviewer claims were **wrong** — see
[§Corrections](#corrections-to-the-adversarial-reviews)).

**Bottom line:** the design is genuinely good and the implementation is **0% functional**. One root
cause — the install target is wrong — means `/analyze` and all 9 agents are undiscoverable, and a
4th independent bug means the orchestrator would not read its arguments even if they were. Beneath
that: a fake resumability claim, two unaddressed injection channels, silent report corruption, and
legacy model pins.

---

## PART 1 — FINDINGS

**F** fatal · **H** high · **M** medium · **L** low

### F1 — Wrong install target ⇒ *zero* agents and *zero* commands are discovered

`~/.claude/skills/groundtruth/` is not a discovery root for either.

**Documented roots** ([sub-agents](https://code.claude.com/docs/en/sub-agents)): `.claude/agents/`,
`~/.claude/agents/`, `--agents`, managed settings, plugin `agents/`. [skills](https://code.claude.com/docs/en/skills)
contains exactly one line on bundling agents from a skill folder: *"add a `.claude-plugin/plugin.json`
to a skill folder and it loads as a plugin named `<name>@skills-dir`, so it can bundle agents,
hooks, and MCP servers."* There is no documented scan of skill-folder `commands/`, and the
command-name table has no row for it.

> **Empirically confirmed.** Baseline probe → nothing listed. Copy `discovery-agent.md` to
> `~/.claude/agents/` → `groundtruth-discovery` appears immediately. And:
> `$ claude -p "Is there a slash command named 'analyze'?"` → **No.** Only `/groundtruth` exists.

All 9 agents and the single orchestrator are inert. Nothing in this repo has ever run.

### F2 — `SKILL.md` has no frontmatter, so the skill has a description of "Groundtruth"

`SKILL.md:1` is `# Groundtruth`. Frontmatter is entirely absent, and [docs](https://code.claude.com/docs/en/skills):
*"Claude Code reads the frontmatter only when the opening `---` is the file's first line."* The
description degrades to the first body line — observed verbatim: `/groundtruth`'s description is
"Groundtruth". Model-invocation can never trigger it.

`commands/analyze.md` and all 9 agents *do* have valid frontmatter. The one file that most needs it
is the one that lacks it.

> Compounding, and the reason `lint-frontmatter.mjs` is mandatory, not nice-to-have: *"A field name
> must match the table exactly… Claude Code ignores a field it doesn't recognize without reporting
> an error."* A typo'd `tool:` silently yields an agent with **full tool access**.

### F3 — The orchestrator never reads its arguments. Every documented entry point is dead.

```
$ grep -rn 'ARGUMENTS\|\$0' commands/ SKILL.md agents/
(no matches)
```

`analyze.md:66` says *"Pasted directly in chat"*, but a slash command's arguments arrive as
`$ARGUMENTS`, not as ambient chat text. `README.md:31` (`/analyze https://…`),
`SKILL.md:15`, and `analyze.md:67` (the urls.txt form) all depend on `$ARGUMENTS`. Independent of F1
and F2 — it survives every fix that addresses those.

### F4 — Resumability is a headline feature that cannot work, and fails *silently*

`README.md:73` promises *"picks up exactly where it stopped."* `PIPELINE_STATE.md` is status-only
(✅/⏭️/❌) and contains **no field for agent payloads** — verified. Meanwhile `analyze.md:237`
requires the reconciler to receive *"all five blocks"* that exist only in a dead session's context
window.

The promised failure mode — timeout, context exhaustion, rate limit — is exactly what guarantees
resume fails. And it fails as **✅ over a total miss**: cells read complete, the orchestrator skips
to Step 5, hands the reconciler nothing, and the repo is never analyzed. Worst failure class in a
tool whose pitch is trust.

> Aggravating detail from research: `maxTurns` truncation is marked partial only on client
> ≥ v2.1.246. On older clients a truncated agent is indistinguishable from a complete one — the
> same failure class, in a different field.

### H1 — Output-format injection. An attacker's README can forge a verifier verdict. **Unaddressed.**

Every agent's prompt ends in a fenced markdown template (`analyzer-agent.md:78-120`,
`technical-verifier.md:62-92`, and 7 more). `analyzer-agent.md` Phase 6 extracts "every specific,
verifiable claim from the README," and `technical-verifier` then adjudicates *that table*.

So a README containing a forged `## ANALYSIS_REPORT` with a `### Claims to Verify` table — a table
shape the analyzer is pattern-matching on — can be copied verbatim into the analyzer's own output.
The technical-verifier then adjudicates the attacker's claim list. The reconciler's priority ladder
ranks `ANALYSIS_REPORT` last but it is the *only* source for anything no verifier could adjudicate,
and its Step 5 template renders ✅/⚠️ into the user's report (`meta-reconciler.md:96-98` shows
exactly a fabricated ✅ row).

An injection-preamble does not help: a forged block is **data shaped like output**, not an
instruction. This is the single highest-severity finding and the one the first draft of this plan
missed.

### H2 — Nested `CLAUDE.md` / `.claude/skills/` auto-load. Deleting line 34 does nothing.

`analyzer-agent.md:34` tells the agent to read `AGENTS.md`/`CLAUDE.md`/`SKILL.md` from an untrusted
repo. But the analyzer's *entire job* is `Read`ing files under `sources/<repo>/`, and
[memory docs](https://code.claude.com/docs/en/memory): *"Files in subdirectories load on demand when
Claude reads files in those directories."* So the platform auto-loads
`sources/<repo>/CLAUDE.md` and `sources/<repo>/.claude/skills/*/SKILL.md` as **instructions and
skill definitions** without the agent choosing to, and applies their `allowed-tools`: *"Workspace
trust doesn't gate this field… Claude Code applies a project skill's `allowed-tools`… including in a
`-p` run in a folder you've never trusted."*

A hostile repo shipping `.claude/skills/x/SKILL.md` with `allowed-tools: Bash Write Edit` gets those
pre-approved. `--add-dir`/`/add-dir` on `sources/<repo>` does the same and (per research) may not
prompt for a subdirectory of cwd.

### H3 — `disableAllHooks` in a hostile `.claude/settings.json` disarms the entire hook defense

[settings-reference](https://code.claude.com/docs/en/settings-reference#disableallhooks): *"In any
other settings file: Claude Code disables user, project, local, and **plugin** hooks."* One JSON line
in the host project kills every hook the plugin ships. `permissions` docs add: *"Setting it in your
user settings alone isn't enough, because the repository's project settings take precedence."*

**Partial mitigation (verified):** settings load from cwd's `.claude/` with **no parent-directory
fallback and no downward scan**, so `sources/<hostile-repo>/.claude/settings.json` is *not* read.
The risk is the host project, not the clone. But the plan's chosen enforcement layer is the one
layer that gets switched off.

### H4 — Silent concurrent-write corruption of the report

`meta-reconciler.md` holds `Read, Write` and mandates *"Append the following section to the report
file."* `analyze.md:213` guards with a **prompt instruction** — "one meta-reconciler at a time" —
which is not enforcement. Nothing stops two reconcilers `Read`→append→`Write` the same file.

No **idempotency key** either: re-running appends a second copy forever. And
`meta-reconciler.md:153` (*"Write once — do not read-modify-write"*) contradicts its own Step 1
(*"Read the current REPORT_PATH file"*). `analyze.md:6b` then invokes the reconciler *again* to
rewrite the header over the whole file.

### H5 — `package.json.files` is an allowlist that silently drops the plugin manifest

```bash
$ npm pack --dry-run        # 19 files
```
No `.claude-plugin/`, no `hooks/`, no `scripts/`, no `config/`. `files` (package.json:24-33) is an
allowlist, so **adding a manifest to the repo does nothing for the primary distribution path.** The
same defect silently drops Phase 2's `scripts/state.mjs`, Phase 3's hooks, and Phase 4's
`config/models.json` — one line breaks four phases. `install.js:13 COPY_DIRS` never copies them
either.

### H6 — `npx` re-run destroys the user's accumulated research

`install.js:13` copies `tracking/` and `output/` with `cpSync` **over** the existing install, no
backup, no check. So the documented update path (`README.md:28`) **overwrites `REGISTRY.md` and
`groundtruth-report.md` with empty templates** — silently destroying the registry and every
completed profile. On a tool whose entire accumulated value *is* the registry, this is the most
user-hostile line in the repo.

### H7 — Legacy model pins, and provider-dependent alias resolution

5 of 9 agents pin `claude-sonnet-4-6` / `claude-opus-4-6` — verified **legacy** against the current
lineup (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`). The 4 Haiku agents pin the
*current* Haiku ID, but as a full ID, forfeiting portability — and Haiku 4.5's documented retirement
is *"not sooner than October 15, 2026"*, roughly two weeks out.

Full IDs also foreclose alias portability. [model-config](https://code.claude.com/docs/en/model-config#model-aliases):

| Provider | `opus` | `sonnet` |
|---|---|---|
| Anthropic API | Opus 5.5 | Sonnet 5.5 |
| Claude Platform on AWS | Opus 5.5 | **Sonnet 4.6** |
| Bedrock / Google Agent Platform | Opus 5.5 | **Sonnet 4.5** |
| Microsoft Foundry | **Opus 4.6** | **Sonnet 4.5** |

Two further verified traps: *"In two cases, a family alias such as `opus`… resolves to the main
conversation's model instead of the version the alias points to"* — so `model: sonnet` does **not**
reliably mean Sonnet 5.5. And Sonnet 5.5 needs client ≥ 2.1.284, Opus 5.5 ≥ 2.1.280.

### M1 — Registry is prose; repo identity collides; a comment can inject a phantom entry

- `analyze.md:73` "Extract all known URLs" from an LLM-parsed markdown table → silent new/existing
  misclassification, no schema, no atomic update.
- **Repo identity is the bare name** (`analyze.md:97`, last path segment). `acme/tool` and
  `other/tool` both map to `sources/tool/` → collision, cross-contaminated analysis, wrong answer.
- Sharper than "no validation": `REGISTRY.md:27` contains `- **URL**: https://github.com/org/repo`
  inside an HTML comment — **the only URL-shaped string in a zero-entry file**. Extract "all known
  URLs" and you get the template. Next run classifies it `EXISTING_REPOS` → `NO_DRIFT` path →
  **analysis skipped permanently.** `WATCH_LIST.md:16` has the same template.

### M2 — The three "independent" verifiers are one verifier run three times

`analyze.md:197-199` gives all three the **same `ANALYSIS_REPORT`** and **same `REPO_PATH`**, same
model family, overlapping read budgets (analyzer ≤20, technical ≤15). The reconciler's ladder
(`meta-reconciler.md:38-42`) ranks code evidence highest. Self-consistency research is unambiguous
that shared inputs ⇒ correlated failure; agreement is then reported as ✅. No mechanism detects it;
the hierarchy conceals it.

Related hard bugs: `conflicts-verifier.md:76` reads *"the **technical verifier's** dependency
list"* but is never passed `TECHNICAL_VERIFICATION` (confirmed: `analyze.md:199` passes three
inputs; its Inputs block lists three). `conflicts-verifier.md:21` defines a **5th tier** `⚠️ partial`
with no mapping into the 4-tier vocabulary or report columns. `meta-reconciler.md:10,31` say "four
agent outputs" for five. `drift-checker.md:51` instructs "Use Glob" but `tools: Bash, Read, Grep`.

### M3 — Drift detection is an LLM reading a CHANGELOG

`drift-checker.md` is a Haiku agent running `git pull`, diffing versions, reading prose to emit a
judgment. Probabilistic, costs tokens, and `:97` says *"if git pull fails… classify as
`MAJOR_DRIFT`"* — a network blip triggers full re-analysis. `git pull` on an untrusted checkout with
the user's real Git identity is also the single highest-privilege operation in the pipeline.

The deterministic answer is free: record `git rev-parse HEAD` at analysis time, compare next run.
Surface (`Connorrmcd6/surface`, Rust + tree-sitter, Google's Open Knowledge Format) blocks merges on
divergence, and its pre-registered 3,250-completion benchmark found stale docs are *worse than no
docs* — with more capable models no more resistant. Groundtruth has no CI gate at all.

### M4 — Security defects the first draft missed

| # | Issue | Evidence |
|---|---|---|
| M4a | `Read`/`Write` survive on `meta-reconciler`. Injection + `Write` to `~/.claude/skills/…/analyzer-agent.md` **rewrites the analyzer's prompt for the next run** — silent, persistent, survives resume | Sandbox blocks this for Bash (`.claude` protected, no `allowWrite` exemption) but `Write` goes through permission prompts/classification |
| M4b | **Exfiltration of the user's own files.** `~/.ssh`, `~/.aws`, `.env`, `~/.claude/projects/**/*.jsonl` (session transcripts) via injected `Read` + `WebFetch`. The plan framed the threat as "repo dictates its own verdict"; this is worse | `sandbox.*` covers **Bash/PowerShell/Monitor only** — not the `Read` tool. And `WebFetch` domain allowlist is **sandboxed-commands-only**: *"in-process tools such as `WebFetch` still follow their permission rules"* |
| M4c | `PostToolUse` `decision: "block"` **does not remove the text** — *"Claude still sees the original output"*. Must use `updatedToolOutput` | hooks docs |
| M4d | Stored injection: the report is attacker-influenced markdown, designed to be *"dropped into any project"*, re-read by future agents | report template |
| M4e | Approval checkpoint is social-engineerable — the *content* of the pause is attacker-shaped | `analyze.md:137` |
| M4f | Plugin agents **ignore** `permissionMode`, `hooks`, `mcpServers`, `initialPrompt` silently | plugin components docs |
| M4g | npm supply chain: `npm audit` is a **no-op** (zero deps); no provenance attestation exists (live `0.1.0` unsigned); `maintainers` is `sathvikcheela` — confirm org control before transferring | verified against live registry |

### M5 — Three-way identity mismatch on the move to fyrlabs

git remote is already `github.com/fyrlabs/groundtruth` ✔. But: `package.json:2` is
`@sathvikc/groundtruth` (and **already published to npm**, live at 0.1.0); `:18,20` point at
`sathvikc/ground-truth` (wrong org *and* a hyphen the repo doesn't have); `:14` `author: sathvikc`;
plus `bin/install.js:109`, `README.md:28`, and 4 refs in `commands/analyze.md`.

Git history: **13** commits, all authored by "Sathvik C". Leave them — rewriting author in a
project about provenance destroys it irrecoverably.

### M6 — Name collision

Four+ unrelated `groundtruth` projects: `sahanaa0420/groundtruth` (6 commits, ships both manifests +
`EVALUATION.md` with an honest null result), `vnmoorthy/groundtruth` (8★, Stop-hook, 153 tests),
`akahkhanna/groundtruth`, `mike-remakerdigital/groundtruth`.

### L1 — No budget rails · L2 — Input surface narrower than docs imply · L3 — No tests at all

`MAX_FILES` (`analyzer-agent.md:127`) is a *prompt instruction*, not a limit. No token ceiling,
wall-clock timeout, concurrency cap, or cost accounting — vs. published baselines of $45–$187/run.
Input validates only `https://github.com/<org>/<repo>`: no GitLab/Bitcrumb, subdir, npm/PyPI, or
**ref pinning** (re-analysis silently tracks moving HEAD).

Zero tests, lint, CI, CHANGELOG, CONTRIBUTING, SECURITY. A tool whose README says *"Confirmed by
reading source files, manifests, or test suites"* ships none, and its report file still reads
`(generated after first pipeline run)` in six sections.

---

## PART 2 — WORTH KEEPING (no prior art found)

1. **Persistent cross-run registry with drift-gated re-analysis.** Every competitor is stateless
   per run or single-purpose. *This is the asset.*
2. **Clone and verify from implementation code.** No competitor adjudicates claims against code.
3. **Extraction separated from verification.** Correct decomposition; matches CRITIC (ICLR 2024).
4. **Inter-repo conflict detection** — compares repos *against each other*, the actual user need.
5. **WATCH_LIST distinct from REJECT** — "not yet good" vs "not good enough."
6. **Human sign-off before publishing a negative profile.** Unusual restraint.
7. **Self-contained, path-free output contract.** Small, real, correctly scoped.

---

## PART 3 — PLAN

**Sequencing note.** The critical path is **0 → 2 → 3 → 5**. Phase 0 is **4–5 days, not 1.5–2**:
packaging, naming, single-distribution-path, path resolution, and argument wiring are five separate
defects and all must land before *anything* is testable.

---

### PHASE 0 — Distribution: make it exist *(F1, F2, F3, H5, H6)* — 4–5 d

**Exit criterion:** from a clean machine, `/analyze <url>` runs and all 9 agents are callable,
verified by an empirical probe in CI.

**0.1 — Pick ONE distribution path. Delete the npx installer.**

Three paths cannot coexist. Docs ([plugins/loading](https://code.claude.com/docs/en/plugins/loading))
resolve same-name conflicts in documented precedence order — a skills-dir plugin and a
marketplace-installed plugin of the same name yields *"Not loaded"*, i.e. **agents and hooks
silently vanish.** Any user who runs both paths loses the tool.

> **Primary: marketplace plugin.** `/plugin marketplace add fyrlabs/groundtruth`. Only path giving
> agent + hook + command discovery **and** a real update/version story
> (`installed_plugins.json`, `claude plugin update`, `/reload-plugins`).
> **Delete `bin/install.js`, the `bin` key, and its `files` entry.** Once the plugin exists it is
> strictly worse: it fights the plugin for the name, and it is the mechanism behind H5 and H6.
> **Keep `--plugin-dir .` as the documented dev loop** (it *should* shadow an installed copy) and
> note that in the risk register.
> **If npm discoverability must be retained**, name the mirror `groundtruth-skill` so it cannot
> collide, and stop presenting it as a supported path.

**0.2 — `.claude-plugin/plugin.json`.** `name: "groundtruth"`, `version` (CI-asserted equal to
`package.json.version`), `description`, `author: {name: "fyrlabs"}`, `keywords`, `license`,
`repository`. Plus `.claude-plugin/marketplace.json`.
Target: `claude plugin validate .` clean.

**0.3 — Strip the `groundtruth-` prefix from all 9 agents' `name:`, and fix all 11 `Task` calls.**

> **Empirically confirmed both directions.** With `name: groundtruth-analyzer` in plugin
> `groundtruth`, the invocable name is **`groundtruth:groundtruth-analyzer`** — and all 11 bare
> `Task` references in `analyze.md` break. With the prefix stripped, it resolves cleanly as
> **`groundtruth:analyzer`**. Docs: *"The name form is `<plugin>:<name>`, where `<name>` comes from
> the frontmatter."*
>
> ⚠️ Two reviewer claims here were **wrong** and I did not adopt them: that a skills-dir plugin
> *double-registers* the SKILL.md body (my probe showed no duplicate), and that bare `/analyze`
> also resolves alongside `groundtruth:analyze` (my probe showed **only** `groundtruth:analyze` —
> so the README needs updating to the scoped form).

**0.4 — Make the orchestrator a skill, not a command file.** `commands/analyze.md` →
`skills/analyze/SKILL.md`.

Docs: plugin `commands/` is *"the older format… **Prefer `skills/` for new plugins**"*. Skills gain
what commands cannot: `name`, `paths`, and **`arguments`/`$name` substitution** — which is the fix
for F3. Verified target surface: `/groundtruth:analyze`.

**0.5 — Wire `$ARGUMENTS` and add frontmatter.** In `skills/analyze/SKILL.md`:

```yaml
---
name: analyze
description: Verified, code-grounded research profiles for GitHub repos. Use when evaluating, comparing, or writing up third-party repos, tools, libraries, or plugins — clones each repo and tags every claim with the evidence behind it.
when_to_use: Triggers on "is X legit", "compare these repos", "research these tools", "due diligence on <repo>", "is this project maintained", "should we adopt <library>".
argument-hint: [github-url ... | path/to/urls.txt]
arguments: [targets]
allowed-tools: [Read, Grep, Glob, Task, WebFetch, WebSearch]
---
```

Body must consume `$targets` and `$ARGUMENTS` (the no-args resume case). **Do not** put `model:` or a
flat `Bash` in `allowed-tools`: `model` applies *"for the rest of the current turn"* only (Step 0 is
that turn — everything after runs on the session model), and pre-approving unrestricted `Bash` on a
tool whose purpose is ingesting hostile repos is a large blast radius. Use narrow specifiers
(`Bash(git clone:*)`) or nothing.

Description budget: drafted text is **559 of 1,536 chars** — no constraint problem, and the cap is
configurable via `skillListingMaxDescChars`. The real risk is *under*-description; spend the room.

**0.6 — Define a path-resolution contract (do this before Phase 2).** Every path in every prompt is
currently cwd-relative while the installer seeds them into `~/.claude/skills/groundtruth/` — **so
the seeded files are never read by anything.** The first draft's claim that state "leaks globally"
was backwards.

- Per-project, shareable: `${CLAUDE_PROJECT_DIR}/.claude/groundtruth/{tracking,output,sources}/`
- Plugin-private, survives updates: `${CLAUDE_PLUGIN_DATA}/`
- Bundled read-only prompts: `${CLAUDE_PLUGIN_ROOT}/`
- `tracking/` and `output/` are **created on first run, never shipped.** That deletes H6 outright.
- Delete `analyze.md:302-308` "Sources Folder Check" — it runs `git ls-files` in the *user's*
  project while the `.gitignore` it cares about is in the *skill* directory. It inspects the wrong repo.

**0.7 — Stop shipping the report template.** `output/groundtruth-report.md` (74 lines, six
`(generated after first pipeline run)` placeholders) → `test/fixtures/expected-report.md` as the
renderer's golden file. Under render-from-state it is indistinguishable from a real result, and it
is what H6 overwrites.

**0.8 — `scripts/verify-layout.mjs`** — the test that would have caught F1–F3. Asserts:
1. `SKILL.md` line 1 is `---`; description non-empty
2. every agent `name:` has **no `:` and no `groundtruth-` prefix**; resolved name = `groundtruth:<name>`
3. every agent name referenced in `skills/analyze/SKILL.md` resolves under the plugin namespace
4. every tool *named in an agent body* appears in its `tools:` list, **and vice versa** — this alone
   catches `drift-checker`'s Glob, `technical-verifier`'s dead Bash, and `conflicts-verifier`'s
   missing input
5. `plugin.json` exists; `claude plugin validate` passes; `plugin.json.version` == `package.json.version`
6. every path in `package.json.files` **exists in `npm pack --dry-run` output** (H5), and every
   `COPY_DIRS`/manifest path is in the tarball
7. no `https://github.com/` literal in any shipped tracking file (M1 phantom entry)
8. **no agent file declares `permissionMode` or `hooks`** — silently ignored in plugins (M4f)
9. no *resolved* absolute paths outside inline-code spans — do **not** substring-match, or you
   red-flag your own rule text at `analyzer-agent.md:128` and `meta-reconciler.md:149`

**0.9 — `package.json.files`:** add `.claude-plugin/`, `hooks/`, `scripts/`, `config/`, `test/`;
remove `bin/`, `output/`, `tracking/`. Delete `.npmignore` (dead — `files` is the contract) and
`sources/.gitkeep` (tracked but never copied; `install.js:82` writes a `.gitignore` whose only
purpose is a negation for a file that never arrives).

---

### PHASE 1 — Rename sathvikc → fyrlabs *(M5)* — 0.5 d

1.1 `package.json`: `name: "@fyrlabs/groundtruth"`, `author: {name: "fyrlabs"}`,
`repository.url`/`homepage` → `github.com/fyrlabs/groundtruth#readme`. 1.2 Replace every
`@sathvikc/groundtruth` and `sathvikc/ground-truth` across `README.md`, `SKILL.md`,
`commands/analyze.md`, `bin/install.js`. 1.3 `LICENSE:3` → `FyrLabs and Groundtruth Contributors`.
1.4 **npm scope must be created and ownership verified before publishing** — an unclaimed scope is a
takeover waiting to happen. Confirm the live `maintainers` account (`sathvikcheela`) is under org
control before transferring anything. Then `npm deprecate @sathvikc/groundtruth "moved to
@fyrlabs/groundtruth"`. Fallback: unscoped `fyrlabs-groundtruth`. 1.5 **Leave all 13 commits**
attributed to Sathvik C; note it in README credits. 1.6 Add `CHANGELOG.md`.

**Verify:** `grep -rn sathvikc .` (excl. `.git/`) empty · `npm pack --dry-run` correct ·
`claude plugin validate` clean.

---

### PHASE 2 — Real state, real resumability *(F4, H4, M1, M3)* — 6–8 d

*(Was 3–4 in the first draft. Under-priced ~2×: it contains a JSON Schema, a lockfile discipline, a
deterministic renderer with golden tests, a run-level synthesizer, SHA drift, an identity migration,
and a killable-resume test.)*

2.1 **Structured, atomic state.** `tracking/runs/<run-id>/state.json` (schema-versioned) +
per-repo payloads `repos/<owner>__<repo>/{manifest,drift,analysis,technical,community,conflicts,spotcheck}.json`.
All writes via `scripts/state.mjs`: **`.tmp` + `fs.rename`** (atomic on POSIX) + a lockfile that
refuses concurrent writers. Migration path from `PIPELINE_STATE.md`.

2.2 **Identity + no example values.** Key on `owner__repo` everywhere; `sources/<owner>__<repo>/`.
`state.json` must **never carry example values** (M1's phantom-entry trap becomes a hard bug the
moment parsing moves to code).

2.3 **Deterministic drift.** Record `git rev-parse HEAD` per run → `NO_DRIFT` (identical SHA) /
`CONTENT_DRIFT` (SHA differs → spot-check) / `SEMANTIC_DRIFT` (major manifest bump or breaking
changelog → full re-analysis) / `UNKNOWN_DRIFT` (surface to human — **do not** assume MAJOR).
Run the LLM judgment only when a SHA changed. Fetch with `git -c credential.helper= ls-remote`
(no local write, no credential) — **drop `git pull` on untrusted checkouts entirely.** Best
cost/benefit ratio in the plan; pull it early.

2.4 **Single-writer, generated report.** The report is **rendered from state by a deterministic
script**. The reconciler emits `profile.json`; the renderer composes markdown. This makes concurrent
writes structurally impossible, idempotent by construction, and regenerable. Fixes H4 at the
script layer — which is strictly stronger than any hook (see 3.6).

Ship with it:
- a **`profile.json` JSON Schema** carrying a `prose` block (`verdict`, `what_it_does`,
  `how_it_works`, `analyst_notes`, `conflicts[]`) — every string LLM-authored, every other field
  typed. A renderer can only emit `Verdict`/`Analyst Notes` if the LLM authors them as strings; the
  first draft asserted this without specifying the contract.
- **a `run.json` synthesizer** written by *one* agent after all profiles exist, replacing
  `analyze.md:6a` and `6b` (two writers over the whole file) with one.
- `meta-reconciler` loses `Write` and `REPORT_PATH`; it writes `profile.json` via a provided script
  (`Write` cannot `mkdir tracking/repos/<id>/`).

2.5 Per-project state (0.6). 2.6 `heartbeat_at` + `/groundtruth:status`. 2.7 **Pin refs** —
anything earning a ✅ records the exact SHA/ref analysed.

**Verify:** kill a run mid-analysis → restart → reconciler receives real payloads, no repo analyzed
twice. `render(state) === render(state)` byte-identical. Every `description`/body naming a renamed
file is updated.

---

### PHASE 3 — Security: treat every input as hostile *(H1, H2, H3, M4)* — 3–4 d

3.1 **`SECURITY.md` + threat model.** Cloned content, all its AI-metadata files, and all web-fetched
text are **untrusted DATA, never instructions.** Enumerate: instruction injection (H2), output
forgery (H1), self-escalation via agent config (M4a), exfiltration of the user's files (M4b),
`git` credential/config vectors, symlink+submodule escape, resource exhaustion, stored injection
(M4d), social-engineered approval (M4e).

3.2 **Never read clones from inside the project tree.** This is the H2 fix and it is structural, not
prompt-level. Clone to `$TMPDIR/groundtruth-clones/<owner>__<repo>` (or `${CLAUDE_PLUGIN_DATA}/`),
outside cwd. Add `omitClaudeMd: true` to all 9 agents (verified valid, and supported in plugin
agents). Add a `PreToolUse` deny on `**/.claude/**` and `**/{CLAUDE,AGENTS,GEMINI}.md` under the
clone root.

3.3 **Injection preamble in all 9 agents** — untrusted content is never instruction.

3.4 **Least privilege.** `technical-verifier` and `drift-checker` → **drop `Bash`** (after 2.3 the
drift-checker has nothing to shell out; `technical-verifier.md:97` invites Bash and must be
reworded to "report the glob pattern and count"). `analyzer` keeps `Bash` **only** for
`git log -1 --format=%ci` (`analyzer-agent.md:62` is a hard dependency — the first draft's
"analyze.md runs the commands for you" describes a step that does not exist; add it as an explicit
orchestrator step, reusing 2.3's SHA fetch). Add **`disallowedTools: Write, Edit` to all agents** —
verifiers must not alter what they verify, and this is the M4a self-escalation fix (works in plugins,
verified).

3.5 **Clone hardening** in `scripts/clone.mjs`, before any agent runs: `--depth 1 --no-tags
--single-branch`, `--no-recurse-submodules`, size/file-count caps enforced **deterministically**
(not by prompt), reject symlinks escaping the root, reject any tree containing `.claude/`,
`CLAUDE.md`, or `AGENTS.md`. Never execute anything from a checkout. Note: `update = !command`
submodule RCE **did not reproduce** on git 2.50.1 — test before shipping that defence as necessary.

3.6 **Hooks — honest scope, correct mechanisms.**
- **Enforcement: `PreToolUse` only.** `matcher: "Read|Grep|Glob"` → `permissionDecision: "deny"` on
  paths under the clone root matching M4 paths, so content never enters context.
- **Detection: `PostToolUse` must use `updatedToolOutput`** to *replace* the body
  (`decision: "block"` still shows the original), plus `additionalContext` warning the agent. Log to
  `tracking/injections.jsonl`. This is **evidence, not prevention** — label it that way.
- **Path-blocking is `PreToolUse`, content-scrubbing is `PostToolUse`.** `PreToolUse` cannot scan
  content; it only sees paths. The first draft conflated these.
- **Delete the `Write|Edit` "assert it came from the renderer" hook.** `PreToolUse` input has no
  caller-identity field, so it cannot distinguish renderer from subagent — and 2.4 makes the
  problem structurally impossible anyway. Dead code that looks like a control.
- ⚠️ **`disableAllHooks` caveat goes in SECURITY.md**, not buried: a project `settings.json` can
  disable plugin hooks. **Hooks are advisory by construction.**

3.7 **Three layers, stated accurately** (first draft's ordering was wrong):

> `permissions.deny` (absolute, beats everything) → `permissions.ask` (a hook's `allow` cannot
> suppress it) → `PreToolUse` hook (can block; never allows past deny/ask) → `permissions.allow`
> (hook can block over it) → **sandbox** (orthogonal; Bash/PowerShell/Monitor only).
> A hook can only ever **subtract** capability. `if` filters are best-effort and are **not** an
> allowlist.

- Sandbox `denyRead` on `~/.claude/**` is **sound and unconditional** (verified: no `allowWrite`
  exemption) — keep as defense-in-depth.
- But the sandbox does **not** govern the `Read` tool. That needs `permissions.deny` `Read(~/.ssh/**)`,
  `Read(~/.aws/**)`, `Read(//**/.env)`, `Read(~/.claude.json)`, `Read(~/.claude/projects/**)` +
  `permissions.blockReadsOutsideWorkingDirectories` (M4b).
- And **no shipped config can constrain `WebFetch` exfiltration** — the domain allowlist applies to
  sandboxed commands only. Say so plainly.

3.8 **Optional guardrails block** (`permissions.deny` + `sandbox.*`, `failIfUnavailable: true`).
A plugin **cannot ship these** — only `agent` and `subagentStatusLine` take effect from a plugin's
`settings.json`. So: ship `scripts/install-guardrails.mjs` that writes them to `~/.claude/settings.json`,
and mark them **opt-in**. Phase 3's CI gate may therefore only assert the *plugin-enforced* layers
(3.2, 3.4, 3.6); the guardrails get their own opt-in test.

3.9 **Output-format injection — H1's actual fix** (the first draft had no defence here):

> Every agent emits a **single JSON object** matching a versioned JSON Schema — **never markdown** —
> validated by `scripts/validate-profile.mjs` at runtime (a CI check is not a gate).
> Reject any verdict whose `cited_file` is outside the clone root, does not exist, **or was not read
> by that verifier in this run** (log every read path to `reads.jsonl` via a `PostToolUse` hook).
> Reject claims tables exceeding a fixed row count/byte size.
>
> Why JSON: it has a terminator. A fenced markdown block does not — a payload containing ` ``` `
> closes your template and emits its own. And `cited_file` provenance is **the same invariant as
> Phase 5.2's anti-correlation mechanism, reused against forgery** — one rule that kills both.
>
> This is the highest-leverage line in the plan.

3.10 **Supply chain.** `npm publish --provenance` + org 2FA; signed git tags referenced from
`SECURITY.md`; disclosure channel, SLA, supported-versions table. `npm audit` is a no-op here (zero
deps) — do not cite it as a control.

**Verify:** a hostile fixture repo (`AGENTS.md` fabricating a ✅ + `curl|bash`; a nested
`.claude/skills/evil/SKILL.md` with `allowed-tools: Bash Write Edit`; a forged `## ANALYSIS_REPORT`
block; an oversized claims table) — assert verdicts are unaffected, no network call is attempted,
and forged blocks fail schema validation. Permanent CI regression.

---

### PHASE 4 — Model portability *(H7)* — 1 d

4.1 **Aliases, not IDs.** `claude-sonnet-4-6` → `sonnet`, `claude-opus-4-6` → `opus`,
`claude-haiku-4-5-20251001` → `haiku`. Source tree ships aliases; **installed agents ship resolved
IDs** (see 4.2).

4.2 **⚠️ `model` is static frontmatter — no script can change it at runtime.** The first draft's
`scripts/resolve-model.mjs` has **no consumer** and is architecturally wrong. Corrected:

> **(a) Install-time generation (default).** Resolve tier → alias → env override → full ID and write
> it into each agent's `model:`. Deterministic, inspectable, **survives `disableAllHooks`** — the
> first draft's plugin hooks would not.
> **(b) Call-time override (opt-in).** A `PreToolUse` hook on `Agent` rewrites `tool_input.model`
> from `config/models.json` (supported: `updatedInput` + `if: "Agent(model:*)"`). Caveats: cannot
> repair an *omitted* parameter, and hooks are best-effort.
> **Do not ship `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`** as a tier mechanism — docs say it ignores
> every subagent's `model` field and forces one model for all, collapsing the tiers and running the
> reconciler on Haiku. Offer it only as a documented "single-model debug" flag.
> Do **not** rely on `GT_MODEL_*` env vars alone (no documented consumer).

4.3 **Reproducibility by install-time capture, not self-report.** A subagent **cannot reliably
report its own resolved model** (`/tasks` is interactive-only; `modelUsage` is session-level
`--output-format json` only). Resolve at install/session start; record `resolved_model`,
`alias_requested`, and `claude_code_version` per tier in `state.json`. For published reports, pin
generation via `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and print the provider-resolution
table in Limitations.

4.4 `maxTurns` on each agent (analyzer needs headroom; the spot-checker's 8 web requests do not) —
**only if client ≥ 2.1.246**, or truncation is silent, which is F4's exact failure class.
`effort` on `opus` agents only: it is a **thinking-budget** control, not a determinism control (the
first draft's rationale was wrong), and it is **silently clamped** — Haiku 4.5 does not support it.

4.5 **Client floor** documented and checked: ≥ 2.1.246 (`maxTurns` marking), ≥ 2.1.280/284
(Opus/Sonnet 5.5).

**Verify:** `GT_MODEL_FAST=haiku` install logs resolved IDs; a run with `opus` unavailable degrades
and is labeled `downgraded: true` rather than failing.

---

### PHASE 5 — Verification quality *(M2, H1)* — 3–4 d

5.1 **Disjoint evidence mandates** — the deepest methodological fix. `technical` → manifests,
`src/`, `tests/`, CI (local only). `community` → `LICENSE`, `NOTICE`, git metadata, GitHub API
(**no source files**). `conflicts` → install scripts, adapters, hook definitions only. Enforce in
prompts *and* in `verify-layout.mjs` (assert the documented read-paths are disjoint).
**Resolve the tension with M2 first:** conflicts-verifier needs the dependency list, so either pass
it a dedicated `DEPENDENCY_MANIFEST` (derived deterministically from manifests, not from the
technical verifier — keeps disjointness intact) or delete its Step 4. Do **not** pass
`TECHNICAL_VERIFICATION` — that would break 5.1.

5.2 **Discount correlated agreement.** A ✅ is load-bearing only if the citing file is not also cited
by another verifier; same-file agreement is downgraded and labeled `correlated`.

5.3 **Unify the tiers.** Four, not five — `conflicts-verifier`'s `partial` becomes a *modifier*
(`⚠️ self-reported (partial support)`) with a real renderer column. Add a coverage line per repo:
`claims: N · verified: N · self-reported: N · contradicted: N · uncovered: N`. STORM's lesson: good
questions are the hard part, and nothing currently guarantees the claim set is complete.

5.4 **Pre-registered evaluation.** Hypotheses, fixtures, n, and tier-accuracy metric declared
**before** running; publish `EVALUATION.md` **including nulls**. Copy the habit from
`sahanaa0420/groundtruth` (6 commits, published a null result) — the practice is worth copying
regardless of its reach; don't imply peer weight.

**Verify:** no file cited by two verifiers; uncovered-count non-zero when a claim is untestable.

---

### PHASE 6 — Engineering infrastructure *(M1, L3)* — 2–3 d

`npm test` → `verify-layout.mjs` + Phase 5 fixtures + Phase 3 injection regression. **Get it green
before anything else ships** (0.8 #9). CI: layout → `npm pack --dry-run` → `plugin validate` →
injection fixture → frontmatter lint.

**`scripts/lint-frontmatter.mjs` must hold TWO schemas** — `AGENT_FIELDS_PLUGIN` and
`AGENT_FIELDS_LOCAL` — and **error** (not warn) when a plugin agent declares `permissionMode`,
`hooks`, `mcpServers`, or `initialPrompt`. These are **silently ignored** in plugins, so a dropped
`permissionMode` is indistinguishable from success (M4f).

Budget rails: token ceiling, wall-clock timeout, concurrency cap, retry/backoff, cost per run vs.
published baselines. Input surface: GitLab/Bitcrumb, `tree/<ref>/<subdir>`, npm/PyPI, **ref
pinning**. Plus `CONTRIBUTING.md`, `CHANGELOG.md`, Dependabot.

---

### PHASE 7 — Positioning & output *(M5, M6, L1–L3)* — 1–2 d

7.1 **Soften the unfalsifiable claim.** "No hallucinations. No blind README trust." → the
defensible moat: **"Clones each repo and verifies its README's claims against the implementation.
Every claim is tagged with its evidence source; untested claims are marked, never asserted."**
Plus an honest Limitations section (benchmarks needing reproduction, decaying live stats,
authenticated-access claims, **`WebFetch` exfiltration being out of scope**, hook defense being
advisory).

7.2 **Comparison table — corrected.** ⚠️ **The first draft cited `ibragimov-oasis/github-deep-research`
as a competitor. It does not exist** (verified `404`; the org has 4 unrelated repos) and the plan
quoted fabricated details from a marketplace listing. `cat-xierluo/legal-skills` exists (707★) but
is a **Chinese-language legal/patent skill collection** — no repo verification, no tiering, no
citation engine. Both claims are struck.

The accurate table: `sahanaa0420/groundtruth` (0★, 6 commits, ships both manifests + `EVALUATION.md`
null result) and `vnmoorthy/groundtruth` (8★, Stop-hook, 153 tests, tuned on a 1,272-turn corpus) —
**both are self-audit gates, not repo researchers.** Plus Repomix/Gitingest/DeepWiki as
adjacent-but-untiered, and `Connorrmcd6/surface` as the drift-detection prior art.

**The clean moat statement: *no project in this space both clones third-party repos and adjudicates
their claims against implementation code; the projects named "groundtruth" are all self-audit
gates.*** Every row must be a URL fetched during this review cycle.

7.3 **Provenance sidecar** — `report.provenance.json`, PROV-O-shaped (`entity`=claim,
`activity`=verification, `wasDerivedFrom`=file+line, `wasAttributedTo`=agent+model,
`invalidatedAtTime`=contradicted). Makes tiers **mechanically auditable** and turns the registry
into a queryable provenance graph.

7.4 **GRADE alignment** — map 4 tiers onto GRADE certainty (the global standard since 2000, which the
first draft presented as reinvented) and add **named downgrade domains** so the report records *why*
evidence is weak: risk of bias (single unverifiable source), imprecision (count within ±5%),
inconsistency (verifiers disagree), indirectness (docs-only), publication bias.

7.5 `llms.txt` alongside the report — dominant agent-consumption format, same "drop it into any
project" use case. **Move 7.4/7.5 behind a working v0.2** — positioning work is consuming days that
Phase 0 and 2 need.

---

## PART 4 — SEQUENCING & RISK

| Phase | Fixes | Est. |
|---|---|---|
| **0** | F1 F2 F3 H5 H6 | **4–5 d** |
| **1** | M5 | 0.5 d |
| **2** | F4 H4 M1 M3 | **6–8 d** |
| **3** | H1 H2 H3 M4 | 3–4 d |
| **4** | H7 | 1 d |
| **5** | M2 | 3–4 d |
| **6** | M1 L3 L1 L2 | 2–3 d |
| **7** | M6 L2 | 1–2 d |
| | **total** | **21–29 d** |

Critical path **0 → 2 → 3 → 5**. 1 and 4 are cheap and independent.

**Not in the estimate** (all real): npm scope creation + deprecation + any user migration path ·
first-run UX for a zero-repo registry (today the only entry points are resume and discovery, both
untested) · `sources/` disk growth and eviction (`--depth 1` helps; nothing cleans up) ·
**multi-repo runs** — nothing in any phase tests more than one repo, yet every real use is N repos.

| Risk | Sev | Mitigation |
|---|---|---|
| Malformed `plugin.json` breaks the skill | H | `claude plugin validate` + `verify-layout.mjs` in CI; document `--plugin-dir .` fallback |
| Same-name collision shadows the install | H | one distribution path only (0.1); name the npm mirror `groundtruth-skill`; `--plugin-dir` shadowing is the *feature* |
| Render-from-state breaks everything downstream | H | Phase 2 before 5/7; renderer as a thin isolated module with byte-identical golden tests (0.7) |
| Hooks over-block legitimate research | M | ship opt-in; narrow `matcher`; PreToolUse denies scoped to the clone root |
| Hooks disabled by host `settings.json` | **H** | documented in SECURITY.md as advisory; 3.4 `disallowedTools` + 4.2(a) install-time IDs survive hook loss |
| Aliases hurt reproducibility | M | 4.3 install-time capture; `ANTHROPIC_DEFAULT_*` pinning for published reports |
| `@fyrlabs` scope unavailable | M | verify before publishing; unscoped fallback |
| Evaluated tier accuracy is **low** | M | **that is a finding, not a failure** — publish it |

**Out of scope:** git history rewriting; reproducing benchmarks; any claim the tool "verifies
security"; non-GitHub VCS beyond 6.x.

---

## PART 5 — TOP FIVE

1. **The project has never run.** F1+F2+F3 are three independent reasons, each sufficient. This is
   not polish — distribution *is* the feature.
2. **Resumability is the feature that isn't.** A ✅ can mean "done" *or* "payload lost, nobody will
   know." A confident marker over a total miss, in a tool whose pitch is trust.
3. **Two injection channels, both structural.** The platform auto-loads the attacker's `CLAUDE.md`
   and `.claude/skills/` (H2) — deleting `analyzer-agent.md:34` accomplishes nothing. And a forged
   `## ANALYSIS_REPORT` in a README is **data shaped like output**, which no injection preamble
   catches (H1). Phase 2's JSON + `cited_file` provenance is the fix for both, and it doubles as
   Phase 5's anti-correlation rule.
4. **Your three "independent" verifiers share their input.** One verifier run three times, and the
   reconciler's ladder converts that into false confidence.
5. **Nothing is tested.** One file — `verify-layout.mjs` — would have caught all three fatal bugs.

---

## Corrections to the adversarial reviews

Recorded because two reviewers' claims were wrong and acting on them would have caused regressions:

| Reviewer claim | Reality |
|---|---|
| "Skills-dir plugin double-registers SKILL.md as both `groundtruth` and `groundtruth:groundtruth`" | **My probe showed no duplicate.** Not adopted. |
| "Bare `/analyze` also resolves alongside `groundtruth:analyze`" | **My probe showed only `groundtruth:analyze`.** README must document the scoped form. |
| "`cat-xierluo/legal-skills` ships repo research with comparative matrices + citation engine" | **False** — verified: it's a Chinese-language legal/patent skill collection. Struck from 7.2. |
| "`ibragimov-oasis/github-deep-research` claims 'confidence-scored assessments'" | **False** — repo 404s; quoted text was invented from a listing. Struck. |
| "PostToolUse `block` removes injected content" | Wrong — it annotates. Corrected to `updatedToolOutput` (3.6). |
| "11 commits by Sathvik C" | **13.** |

Also adopted with correction: the reviewer's central model-portability catch — **a script cannot
change `model:` at runtime** — was correct and invalidated the first draft's
`scripts/resolve-model.mjs` design (4.2).