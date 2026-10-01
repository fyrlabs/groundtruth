# Design decisions

Ratified decisions. If a change contradicts an entry, the entry wins until it is amended.

Entries are added when semantics change, a guarantee is established, or a tradeoff is settled — not
for every commit. House style: **Decision / Reasoning / Alternatives considered / Tradeoff**. The
*why* is the point; an entry stating an outcome without the reasoning that produced it is incomplete.

Amending an entry? Add a dated amendment block. Do not rewrite history.

---

## 1. Ship as a plugin; drop the npx installer

**Decision.** Groundtruth is a Claude Code plugin installed via
`/plugin marketplace add fyrlabs/groundtruth`. The hand-rolled `bin/install.js` is removed.

**Reasoning.** A skill folder only gains agent, hook, and command discovery by also carrying a
`.claude-plugin/plugin.json`, which makes it load as a plugin. The npx installer wrote the same
folder under the same name, and Claude Code resolves name conflicts in a documented precedence order
where a same-named plugin is silently *not loaded* — so a user who ran both paths lost their agents
and hooks with no error. The installer also copied `output/` and `tracking/` over the existing
install on every run, so the documented update path replaced the user's registry and every completed
profile with empty templates.

**Alternatives considered.** Keeping both with distinct names: rejected, since two distribution paths
for one tool doubles the support surface for no capability. An npm-only mirror: still allowed, but
named `groundtruth-skill` so it cannot collide, and not a supported path.

**Tradeoff.** No `npx` one-liner, so npm is not a discovery channel. Acceptable — the marketplace is
how this category is distributed, and the plugin path is the only one that gives hooks and updates.

## 2. Agents do not carry the `groundtruth-` prefix

**Decision.** Agent frontmatter `name:` is unprefixed (`analyzer`, `spot-checker`). The plugin
namespace applies the prefix.

**Reasoning.** Plugin agents resolve as `<plugin>:<name>`. With a prefix, `name: groundtruth-analyzer`
resolved as `groundtruth:groundtruth-analyzer`, and all eleven `Task` references in the orchestrator
named agents that did not exist. Verified empirically with a scratch plugin.

**Alternatives considered.** Prefixed names plus updated call sites: strictly more fragile, since a
rename then touches both files.

**Tradeoff.** Two projects named `groundtruth` could both export an agent called `analyzer`; plugin
scoping handles it, and `verify-layout.mjs` asserts uniqueness within this plugin.

## 3. The orchestrator is a skill, not a command file

**Decision.** `skills/analyze/SKILL.md` registers as `/groundtruth:analyze`.

**Reasoning.** Commands and skills have merged in the host, and the docs recommend `skills/` for new
plugins. More decisively, command files cannot use `name` or `paths` frontmatter, and only skills
support `arguments`/`$name` substitution — which is what makes `/groundtruth:analyze <url>` work
instead of relying on ambient chat text.

**Alternatives considered.** Plugin `commands/` → `/groundtruth:analyze`: viable, but loses argument
substitution. A plugin-root `SKILL.md` with `name: groundtruth`: produces `/groundtruth:groundtruth`.

**Tradeoff.** `/analyze` unscoped does not resolve under plugin scoping. Documented form is
`/groundtruth:analyze`.

## 4. Clones live outside the project tree

**Decision.** Clones go to `~/.cache/groundtruth/sources` (override: `GROUNDTRUTH_CLONE_DIR`), never
inside a project.

**Reasoning.** The host loads `CLAUDE.md`, `AGENTS.md`, and `.claude/skills/**/SKILL.md` from a
directory the moment an agent reads a file there — and applies a project skill's `allowed-tools`
without requiring workspace trust. A repository cloned inside the project could therefore install
instructions and pre-approve tools without the agent choosing to read anything. Removing the line
from the analyzer prompt that said to read `AGENTS.md` accomplishes nothing on its own; the platform
does it automatically.

**Alternatives considered.** Cloning into the project and relying on the injection preamble:
rejected, the preamble addresses instructions and cannot address automatic loading. A separate
container per repo: strongest, but not proportionate to a research tool.

**Tradeoff.** Clones are not visible in the project tree. `scripts/paths.mjs` prints the location.

## 5. Repositories carrying harness control files are refused

**Decision.** `clone.mjs` rejects any tree containing `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
`GEMINI.md`, `.cursorrules`, `.claude/`, `.gemini/`, or `.cursor/`, and enforces size, depth, file
count, and symlink-escape caps.

**Reasoning.** A repository that ships these is asserting control over whatever reads it. Groundtruth
reads code and extracts claims; it declines to be instructed. Capping size and file count
deterministically is also the only way to stop a repository engineered to exhaust a token budget —
asking the model to be careful is not a limit.

**Alternatives considered.** Stripping the files after cloning: rejected, they may already have been
loaded. A prompt-only rule: rejected, same reason.

**Tradeoff.** Legitimate projects that ship a `CLAUDE.md` cannot be analysed at all. The report
would say so rather than silently proceeding.

## 6. Agents emit JSON; verdicts must cite a file that exists

**Decision.** Every agent's payload is JSON validated against `core/schema/*.json`. A verdict's
`cited_files` must resolve to real files inside the clone root, or the payload is rejected.

**Reasoning.** The attack instruction-level defences cannot touch is **output-format forgery**: a
repository README containing a block shaped like our own output, which an agent matching on that
shape may copy verbatim. It is *data shaped like output*, not an instruction, so no preamble catches
it. Making citations load-bearing defeats it — the attacker controls the README, which is the one
file a verdict cannot legitimately cite. The same invariant defeats hallucinated confirmations.

**Alternatives considered.** Prompt-level defences alone: rejected for the reason above. Markdown
with delimited sections: rejected, a payload containing the delimiter closes the section and emits
its own. JSON has a terminator.

**Tradeoff.** Agents cannot express a verdict about something that is not a file in the repo — for
example a live benchmark number. Those are `unverifiable` with no citation requirement.

## 7. The verifiers have disjoint evidence surfaces

**Decision.** `technical-verifier` reads manifests, source, and tests; `community-verifier` reads
licensing, git metadata, and live pages; `conflicts-verifier` reads installers, adapters, and hooks.
`verify-layout.mjs` and the agent prompts both state the boundary.

**Reasoning.** Self-consistency research is unambiguous that verifiers sharing inputs and priors fail
together. All three originally received the same `ANALYSIS_REPORT` and `REPO_PATH` on the same model
family, making them one verifier run three times — and the reconciler's priority ladder converted
their agreement into apparent confirmation.

**Alternatives considered.** One verifier with more context: cheaper, but then there is no
cross-checking at all. Overlapping surfaces with a correlation discount: kept as a *second* line of
defence, not the primary one.

**Tradeoff.** More total tokens than three overlapping agents, and some claims need two surfaces to
adjudicate. `conflicts-verifier` takes a derived `DEPENDENCY_MANIFEST` rather than the technical
verifier's output, specifically to preserve disjointness.

## 8. Correlated agreement is downgraded and disclosed

**Decision.** When every verdict on a claim cites the same file, the claim is marked `correlated`,
and the validator rejects a `code-verified` tier that rests only on such agreement.

**Reasoning.** Agreement from a shared source is one opinion counted several times. Presenting it as
independent verification is the specific failure mode this architecture exists to prevent, and it is
invisible to a reader who only sees three agreeing verdicts.

**Alternatives considered.** Trusting a majority vote: rejected, majority of correlated samples is
still one opinion.

**Tradeoff.** Some genuinely well-evidenced claims, where several agents reasonably cite one file,
get marked correlated. The note says so rather than hiding it.

## 9. The renderer is the only writer of the report

**Decision.** Models emit `profile.json`. `scripts/render.mjs` produces markdown. Cross-repo sections
come from `scripts/synthesize.mjs`, which is deterministic.

**Reasoning.** The reconciler appended to the report file while holding `Write`, and a second
invocation rewrote the whole file for the executive summary — two writers over one file, guarded by a
prompt instruction, which is not enforcement. With no idempotency key, re-running appended a second
copy of the same profile forever. Rendering from state makes concurrent runs safe, re-renders
byte-identical, and interrupted runs recoverable.

**Alternatives considered.** Keeping model-written markdown with a lock: reintroduces the risk and
loses reproducibility. A model-written report with post-hoc validation: still two writers.

**Tradeoff.** Prose must be authored into the profile's `prose` block, since the renderer cannot
invent judgment. A missing field fails validation upstream instead of producing bland text.

## 10. Resumability is defined by payloads, not by status markers

**Decision.** A stage counts as done only if its payload exists on disk. State is versioned JSON
written atomically via temp file plus rename.

**Reasoning.** `PIPELINE_STATE.md` was a status table with nowhere to store an agent's output, while
the reconciler needed five payloads that existed only in a dying context window. The exact failure
the feature promised to survive — timeout, context exhaustion, rate limit — was therefore the one that
broke it, and it broke as a ✅ over a total miss.

**Alternatives considered.** Persisting only a completion marker: is the bug. Serialising payloads
into the state file: rejected, one file rewritten wholesale per stage loses atomicity for the rest.

**Tradeoff.** More disk state, and a stale payload can outlive its stage. `state.mjs reset` clears it.

## 11. Model tiers are aliases, resolved before dispatch

**Decision.** Source agents declare `model: sonnet` and friends. `scripts/resolve-models.mjs` writes
resolved IDs into installed copies, honouring `GROUNDTRUTH_MODEL_*` overrides.

**Reasoning.** `model` in subagent frontmatter is static text read at spawn time — no script, hook,
or settings key changes it at runtime, so the first design's runtime resolver had no consumer. And a
full ID is provider-specific: `sonnet` resolves to Sonnet 5.5 on the Anthropic API, 4.6 on AWS, and
4.5 on Bedrock and Google Agent Platform, so pinning one hands some users a model nobody chose.

**Alternatives considered.** `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`: rejected, it forces one model for
every subagent, collapsing the tiers and running reconciliation on Haiku. A hook rewriting
`tool_input.model` at dispatch: viable as an override, but hooks are advisory and it cannot repair an
omitted parameter, so it is not the primary mechanism.

**Tradeoff.** Reproducibility requires pinning. The run records the alias requested, the resolved
model, and the client version, captured at install rather than self-reported — a subagent cannot
reliably report its own resolved model.

## 12. Hooks are defence in depth, and the docs say so plainly

**Decision.** Plugin `hooks/hooks.json` guards fetch-and-execute, credential reads, clone mutation,
and writes to harness configuration. `SECURITY.md` states they are advisory and why.

**Reasoning.** A project `.claude/settings.json` can set `disableAllHooks`, which turns off user,
project, local, and plugin hooks. Only managed settings survive. Shipping a guard layer without
saying so would be a false guarantee in a document whose subject is guarantees.

**Alternatives considered.** Making the structural layer carry everything: it mostly does; the hooks
are the second line. Managed settings only: not available to an open-source plugin.

**Tradeoff.** A hostile project can disable hooks. Layers 1 and 2 — clone placement and validator
enforcement — still hold, and that is stated in both the code and the docs.

## 13. The core is harness-neutral; the plugin is one adapter

**Decision.** `core/` contains no harness-specific syntax. `agents/`, `skills/`, and `hooks/` are the
Claude Code adapter. `AGENTS.md` makes the repository usable without Claude Code.

**Reasoning.** Agent Skills and `AGENTS.md` have far broader adoption than any plugin mechanism, so
the portable surface should be the substantive one. Subagents are the genuinely
Claude-Code-specific part, and the parts that matter — clone hardening, validation, injection
refusal, rendering — live in `core/`.

**Alternatives considered.** Generating the Claude adapter from a neutral core: rejected, the
transforms are lossy in both directions (a `tools:`-restricted agent deployed to a host that ignores
`tools` silently gains access), which would make the shipped layout a lie. Restructuring around a
package manager: it excludes agents from its portable core, so it cannot express this project's
product.

**Tradeoff.** Other harnesses get the orchestrator and the deterministic core, not the fan-out. Adding
a host means writing an adapter, not changing the pipeline.