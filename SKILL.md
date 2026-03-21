# Groundtruth

> Verified research documentation for any set of GitHub repos.
> No hallucinations. No blind README trust. Confidence-tiered claims.

## What This Skill Does

Groundtruth is a multi-agent research pipeline. You give it GitHub URLs. It clones the repos, reads the actual source code, verifies claims online, resolves contradictions between sources, and produces a research document where every significant claim has a confidence tier.

It does not trust READMEs. It verifies from code.

## How to Use

```
/analyze https://github.com/org/repo1 https://github.com/org/repo2
```

Or with a file:
```
/analyze /path/to/urls.txt
```

Running `/analyze` with no URLs triggers discovery mode — the pipeline searches online for new repos relevant to the current registry domain.

## Pipeline Agents

| Agent | Model | Role |
|-------|-------|------|
| `groundtruth-discovery` | Haiku | Web search for new repo candidates |
| `groundtruth-triage` | Haiku | Maturity, novelty, duplication gates |
| `groundtruth-drift-checker` | Haiku | git pull + version/changelog diff for existing repos |
| `groundtruth-online-spot-checker` | Haiku | Live GitHub stats, security, deprecation signals |
| `groundtruth-analyzer` | Sonnet | Deep code analysis: tech stack, architecture, claim extraction |
| `groundtruth-technical-verifier` | Sonnet | Verifies claims from actual source code |
| `groundtruth-community-verifier` | Sonnet | Verifies authorship, license, marketplace, live stats |
| `groundtruth-conflicts-verifier` | Sonnet | Platform support matrix, inter-repo conflicts |
| `groundtruth-meta-reconciler` | Opus | Resolves contradictions, writes final report |

## Confidence Tiers

Every significant claim in the output report carries one of these tiers:

| Tier | Symbol | Meaning |
|------|--------|---------|
| code-verified | ✅ | Confirmed by direct code/file evidence |
| self-reported | ⚠️ | Found only in documentation; not contradicted |
| contradicted | ❌ | Directly contradicted by code or authoritative source |
| unverifiable | 🔍 | Requires live execution or unavailable external data |

## Resumability

Every pipeline stage writes to `tracking/PIPELINE_STATE.md` before proceeding.
If a session times out, context fills, or you hit a rate limit:
- Run `/analyze` again (no URLs needed)
- The pipeline reads the state file and continues from exactly where it stopped
- Completed repos are never re-analyzed

## Output

`output/groundtruth-report.md` — self-contained research document.
No local path references. Safe to drop into any project or share publicly.

## File Structure

```
groundtruth/
├── SKILL.md                    ← you are here
├── commands/
│   └── analyze.md              ← /analyze orchestrator
├── agents/
│   ├── discovery-agent.md      ← Haiku
│   ├── triage-agent.md         ← Haiku
│   ├── drift-checker.md        ← Haiku
│   ├── online-spot-checker.md  ← Haiku
│   ├── analyzer-agent.md       ← Sonnet
│   ├── technical-verifier.md   ← Sonnet
│   ├── community-verifier.md   ← Sonnet
│   ├── conflicts-verifier.md   ← Sonnet
│   └── meta-reconciler.md      ← Opus
├── tracking/
│   ├── REGISTRY.md             ← master list of known repos
│   ├── PIPELINE_STATE.md       ← resumability backbone
│   └── WATCH_LIST.md           ← promising-but-not-ready repos
├── sources/                    ← cloned repos (git-ignored)
└── output/
    └── groundtruth-report.md   ← final research document
```

## Design Principles

- **No blind README trust** — every claim is verified from implementation code
- **Quality over speed** — new repos are queued, not rushed; parallelism is within a run, not at the cost of depth
- **Human in the loop** — discovery candidates, deprecation warnings, and replacement suggestions require your approval
- **Resilient** — state is persisted at every stage; interrupted runs resume, not restart
- **Self-contained output** — the report carries no workspace artifacts, making it safe to share
