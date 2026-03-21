# Groundtruth

**Verified research documentation for GitHub repos. No hallucinations. No blind README trust.**

Groundtruth is a Claude Code skill that analyzes GitHub repos and produces research documentation where every significant claim has a confidence tier — verified from source code, not taken on faith from README text.

## The Problem

Every tool's README says it's great. Stars can be gamed. Benchmarks are self-reported. "Works with X" often means "we mentioned X in our docs." When you're evaluating tools to adopt, you're mostly reading marketing.

Groundtruth reads the actual code.

## What It Produces

A research document (`output/groundtruth-report.md`) where every claim is tagged:

| Tier | Meaning |
|------|---------|
| ✅ code-verified | Confirmed by reading source files, manifests, or test suites |
| ⚠️ self-reported | Found only in documentation; not independently confirmed |
| ❌ contradicted | Code or external source directly contradicts the claim |
| 🔍 unverifiable | Requires live execution or data unavailable at analysis time |

## Quickstart

```bash
# Install as a Claude Code skill
npx @sathvikc/groundtruth

# Analyze repos
/analyze https://github.com/org/repo1 https://github.com/org/repo2

# Or from a file (one URL per line)
/analyze /path/to/urls.txt

# Resume an interrupted run
/analyze
```

## How It Works

```
GitHub URLs
    ↓
Clone repos into sources/
    ↓
Per repo: Analyzer (Sonnet) reads code
    ↓
Three verifiers run in parallel (Sonnet):
  • Technical — verifies claims from source code
  • Community — verifies authorship, license, live stats
  • Conflicts  — verifies platform support, inter-tool conflicts
    ↓
Online spot-check (Haiku) — live GitHub stats, deprecation signals
    ↓
Meta-reconciler (Opus) — resolves contradictions, writes final profile
    ↓
output/groundtruth-report.md
```

For existing repos, a drift checker (git pull + CHANGELOG diff) determines whether a full re-analysis is needed or the previous profile is still current.

## Agent Model Allocation

| Task | Model | Reason |
|------|-------|--------|
| Web search, drift check, spot-check | Haiku | High-volume, low-reasoning tasks |
| Code analysis, verification, writing | Sonnet | Code comprehension + synthesis |
| Contradiction resolution, final judgment | Opus | Meta-reasoning requires depth |

## Resumability

The pipeline writes its state to `tracking/PIPELINE_STATE.md` at every stage. If your session times out or hits a rate limit, running `/analyze` again picks up exactly where it stopped. Completed repos are never re-analyzed.

## Output is Self-Contained

`output/groundtruth-report.md` contains no local path references. You can drop it into any project, share it with a team, or publish it — no workspace context required.

## Discovery Mode

Running `/analyze` without URLs triggers discovery: the pipeline searches GitHub, HackerNews, and Reddit for new repos relevant to your current research domain, then surfaces candidates for your approval before analyzing them.

## File Structure

```
groundtruth/
├── SKILL.md
├── README.md
├── commands/
│   └── analyze.md          ← /analyze orchestrator
├── agents/
│   ├── discovery-agent.md
│   ├── triage-agent.md
│   ├── drift-checker.md
│   ├── online-spot-checker.md
│   ├── analyzer-agent.md
│   ├── technical-verifier.md
│   ├── community-verifier.md
│   ├── conflicts-verifier.md
│   └── meta-reconciler.md
├── tracking/
│   ├── REGISTRY.md
│   ├── PIPELINE_STATE.md
│   └── WATCH_LIST.md
├── sources/                ← cloned repos (git-ignored)
└── output/
    └── groundtruth-report.md
```

## License

MIT
