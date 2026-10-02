# Groundtruth

Code-grounded research profiles for GitHub repositories.

Point it at a repository. It clones the repo, enumerates every specific claim the project makes
about itself, and adjudicates each one against the implementation — counting the files rather than
trusting the stated number, resolving "supports X" to the code that implements it, and checking the
licence file rather than the badge.

Every claim in the output carries a tier, a file citation, and — when no verifier could settle it —
an explicit note that nobody did.

## What it actually does

```
/groundtruth:analyze https://github.com/owner/repo [more URLs…]
/groundtruth:analyze /path/to/urls.txt     # one URL per line, # comments allowed
/groundtruth:analyze                        # discovery mode: find candidates in your domain
```

For each repository:

| Stage | What it does |
|---|---|
| **Clone** | Shallow, outside your project, read-only. Repos shipping `CLAUDE.md`/`AGENTS.md` are refused. |
| **Analyze** | Reads the code to enumerate specific, checkable claims with exact quotes and `file:line`. |
| **Verify** | Three agents in parallel, each with a **disjoint** evidence surface. |
| **Spot-check** | Live stats, advisories, deprecation, successor projects. |
| **Reconcile** | Resolves contradictions, assigns tiers, writes `profile.json`. |
| **Render** | A script turns state into the report. No model writes the report. |

Re-running resumes from disk. A completed repository is never re-analysed unless its commit changed.

## The tiers

| Tier | Meaning |
|---|---|
| ✅ `code-verified` | Confirmed by reading implementation code, manifests, or tests in that repository |
| ⚠️ `self-reported` | Documented but unconfirmed — code neither confirms nor denies |
| ❌ `contradicted` | Directly contradicted by code or an authoritative external source |
| 🔍 `unverifiable` | Needs live execution, credentials, or data unavailable at analysis time |

Three properties make these worth more than the symbols suggest:

**A verdict must cite a file that agent actually read.** The validator rejects the payload
otherwise. An agent cannot cite a file it did not open, and a hostile repository cannot forge a
verdict because it controls the one file a verdict cannot legitimately cite as evidence.

**Correlated agreement is discounted.** If every agent cited the *same* file, the claim is marked
`correlated` and their agreement carries no independent weight. Three agents reading one README are
one opinion counted three times. This is why the verifiers are given non-overlapping evidence
surfaces in the first place — agents sharing inputs fail together.

**Uncovered claims are counted, not dropped.** Every profile reports how many claims no verifier
could reach. A report that quietly omits what it could not check is indistinguishable from one that
found nothing wrong.

## Security

Groundtruth reads repositories it does not control and hands the results to language models, so the
input is hostile by default. Four layers, in the order of what they actually buy:

1. **Structure** — clones live outside the project tree, repos carrying harness control files are
   refused outright, clones are read-only, and no agent holds `Write` or `Edit`. This is the real
   boundary, and no settings file can switch it off.
2. **Validation** — agents emit JSON, never markdown, and cited files must exist. This defeats
   output-format forgery, which no instruction-level defence can touch: a README containing a block
   shaped like Groundtruth's own output is *data shaped like output*, not an instruction.
3. **Hooks** — guards block fetch-and-execute, credential reads, clone mutation, and writes to
   harness configuration including Groundtruth's own installed copy. One agent holds `Bash`, and that
   is a real limitation rather than a solved problem: a shell can write a file whatever tools an agent
   holds. `SECURITY.md` says so plainly and names the opt-in mitigation.
4. **Optional guardrails** — `node scripts/install-guardrails.mjs` writes permission deny rules and
   sandbox settings that a plugin is not permitted to ship. Apply these if the Bash limitation matters
   to you.

**Hooks are advisory.** A `.claude/settings.json` in your working directory can set
`disableAllHooks` and turn them off, which is exactly why the structural layer carries the guarantee.

[SECURITY.md](SECURITY.md) states the threat model and, just as importantly, what is **not**
defended — including that `WebFetch` exfiltration cannot be contained by any shipped configuration.

## Install

```bash
/plugin marketplace add fyrlabs/groundtruth
/plugin install groundtruth@fyrlabs
```

Or while working on it:

```bash
claude --plugin-dir /path/to/groundtruth
```

There are no runtime dependencies and no install script. The npm package exists for inspection and
CI, not as an installer.

## Output

| File | What it is |
|---|---|
| `groundtruth-report.md` | The readable profile, per repo plus comparison and methodology |
| `report.provenance.json` | PROV-O record: every claim, its citations, the agents that adjudicated it, contradictions marked `invalidated` |
| `llms.txt` | The same facts in the format agents expect to consume |

All three land under `.claude/groundtruth/output/` in your project. They contain no local paths, so
you can commit one, share it, or drop it into a review.

State — clones, payloads, registry, run history — lives under `.claude/groundtruth/` and is
git-ignored. Override the location with `GROUNDTRUTH_STATE_DIR`; clones move independently via
`GROUNDTRUTH_CLONE_DIR`, because they must never sit inside a project tree.

## Configuration

```bash
# Model tiers: fast (discovery, triage, drift, spot-check), medium (analysis and verification),
# strong (reconciliation). Defaults are aliases, which follow your provider and update over time.
GROUNDTRUTH_MODEL_FAST=haiku
GROUNDTRUTH_MODEL_MEDIUM=sonnet
GROUNDTRUTH_MODEL_STRONG=opus
```

Aliases rather than pinned IDs on purpose: `sonnet` resolves to different versions on the Anthropic
API, AWS, Bedrock, and Foundry, so pinning one hands some users a model nobody chose. Pin a full ID
if you want reproducibility more than currency — the run records what was resolved either way.

## Development

```bash
npm run verify        # layout invariants, frontmatter lint, tests
npm test              # tests only
npm run verify:layout # the invariants that catch distribution mistakes
```

`verify-layout.mjs` is the file that matters most. This project shipped for its entire first version
with nine agents and one command that no harness could discover, because nothing checked layout. The
invariants now cover that, plus: agent names that would resolve double-prefixed under plugin
scoping, `SKILL.md` without frontmatter, a `package.json` `files` allowlist that would ship a plugin
without its manifest, tools named in a prompt but not granted, and `Write` granted to any agent.

## Multi-harness support

The substance is harness-neutral: `core/` (path resolution, clone hardening, validation, injection
detection, rendering) has no harness-specific syntax, and the agent prompts are plain markdown. The
Claude Code plugin is one adapter, and the primary one.

`AGENTS.md` at the root is read by a wide range of coding agents, so this repository is usable
without Claude Code installed. `skills/analyze/SKILL.md` already follows the portable Agent Skills
layout and is consumable by other hosts that read it.

Subagents are Claude Code specific. A host without subagents gets the orchestrator and the
deterministic core — clones, validation, injection refusal, rendering — which is where the security
guarantees and the tier enforcement live. Porting the fan-out means writing an adapter, not changing
the pipeline.

## Related work, and how this differs

- **[Repomix](https://github.com/yamadashy/repomix)**, **[Gitingest](https://github.com/coderamp-labs/gitingest)**,
  **[DeepWiki](https://github.com/AsyncFuncAI/deepwiki-open)** — get a repository's *content* into a
  model. Deterministic and fast. They extract; Groundtruth adjudicates.
- **[Surface](https://github.com/Connorrmcd6/surface)** — keeps one repository's docs from going
  stale via tree-sitter symbol fingerprints, enforced in CI. The better answer for that problem; our
  drift check is a commit-SHA comparison in the same spirit.
- **[sahanaa0420/groundtruth](https://github.com/sahanaa0420/groundtruth)** — a research-sourcing
  discipline for Claude Code: primary sources, traceable claims, and a fan-out of `research-leg`
  subagents. It ships an `EVALUATION.md` reporting a null result, which is a better habit than most.
  It verifies *general research*, not third-party repositories.
- **[vnmoorthy/groundtruth](https://github.com/vnmoorthy/groundtruth)** — a Stop hook that refuses to
  let the agent end a turn on an untested completion claim, tuned against a 1,272-turn corpus. It
  audits the agent's *own* behaviour.

Both constrain what an agent may assert about itself. Neither clones a third-party repository and
adjudicates that repository's claims. That is the difference, and it is the reason neither of them
needs a validator, a clone step, or a provenance graph.

## Honest limitations

- **Benchmarks are not reproduced.** A project's own numbers stay `self-reported` unless an
  independent source corroborates them.
- **Live data decays.** Stars, commit dates, and issue counts are point-in-time; each carries an
  observation date for that reason.
- **Authenticated sources are invisible.** Private registries and paywalled advisories are
  `unverifiable`.
- **Agent judgement can still be wrong.** The validator proves a verdict cites a real file the agent
  read. It cannot prove the agent read it for the right reason. That is why the provenance record is
  published alongside the report.
- **Coverage is not exhaustive.** Claim extraction is a model's judgement about what is checkable.
  A repo that documents less gets a shorter list.
- **`WebFetch` is not sandboxed.** The sandbox network allowlist covers sandboxed commands only.

## License

MIT