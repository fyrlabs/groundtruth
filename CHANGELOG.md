# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-06

First release. The pipeline clones a repository and adjudicates the claims that repository makes about itself against its implementation code, so every verdict carries an evidence tier and a file citation, and anything no verifier could settle is counted rather than dropped.

### Added

- **Claim quotations are verified against the file they cite.** Every published claim now carries the verbatim text it was judged on and the file and line it came from, and that text must actually occur there, within three lines of the line it cites. Before this, a claim's evidence was prose the validator could only check for shape, so a plausible invented quotation passed and reached the report. Line wrapping and typographic quotes are tolerated, because an agent reproducing a rendered Markdown file legitimately loses both.
- **A cited quotation is checked on the profile, not on an intermediate payload.** The profile is the artifact a reader sees, so that is where the check lives.
- **Failures are recorded rather than skipped.** Verification refuses a payload when it cannot run — no repo key, no clone, a non-string path — instead of accepting it unverified.
- **`report.provenance.json` in W3C PROV-O shape**, so every evidence tier can be audited mechanically rather than trusted. Contradicted claims are recorded as `invalidated`.
- **`llms.txt`** alongside the report, for tools that read documentation rather than prose.
- **Releases publish from CI.** Pushing a GitHub release publishes the package with npm provenance attached, so the tarball is attributable to the workflow run that built it. A failed publish is re-runnable without burning a version number, and a version already on the registry is skipped rather than treated as an error.
- **`scripts/install-guardrails.mjs`** for the permission and sandbox settings a plugin cannot ship itself.
- **`config/models.json`** with three model tiers and environment overrides, so a run can be moved between models without editing any agent.
- **`AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/design-decisions.md`, `.github/RELEASE_CHECKLIST.md`, `.github/RELEASE_TEMPLATE.md` and a pull request template.**

### Changed

- **Licensed under Apache-2.0.** `LICENSE` and `NOTICE` ship with the package. Apache-2.0 grants an explicit patent licence, which MIT does not.
- **Clone reuse now requires an intact working tree.** A resolvable `HEAD` was previously treated as proof that a checkout was complete, so an interrupted clone could be analysed as if it were the whole repository. Reuse now compares the files git knows about against the files on disk, less the ones quarantine deliberately removed.
- **Debris at a clone path no longer blocks a clone permanently.** A leftover directory without a `.git` made every later run fail with git refusing a non-empty destination, then write a refusal marker that nothing could clear. Clones are derived from a URL, so an unusable directory at the target is discarded first.
- **`scripts/install-guardrails.mjs --print` no longer writes**, so the settings can be inspected before they are applied.
- **Reports disclose quarantined control files.** A repository that ships its own agent instruction files has them counted and named in the report, having been moved out of the clone before analysis and never read as instruction.

### Fixed

- **CI now runs.** An invalid workflow file meant GitHub created a run with zero jobs on every push, so no test had ever executed in CI while every local gate passed. A malformed `run:` value is now rejected before it can reach `.github/workflows/`.
- **A payload written outside the state directory is no longer possible.** The write gate's `--file` argument doubled as an output path, so a profile could be written where no resume could find it, and the run reported success.
- **A finished repository is recognised as finished.** The resumable stage list named the reconcile stage differently from every write path, so nothing ever wrote it and every resume redid the most expensive stage in the pipeline.
- **A partly-cloned repository is detected and re-cloned** rather than analysed as complete.
- **Repository instruction files are quarantined rather than obeyed**, including `.claude/`, and the report discloses what was quarantined.
- **Claims citing one file on behalf of several agents must disclose it.** Agreement between agents that read the same file carries no independent weight and is now marked as correlated.
- **A verdict may only cite a file the agent that made it actually read**, and the read log must exist: an absent log fails closed instead of passing.

### Security

- Repositories are treated as hostile input throughout. Clones and quarantined control files live outside any project directory, so nothing a repository ships can be loaded as project configuration.
- No agent holds `Write` or `Edit`; all nine write through a gate that validates before accepting.
- The renderer is the only writer of the report, so two writers cannot produce a corrupted file.
- Zero runtime dependencies, deliberately. This tool reads untrusted repositories and hands the results to models, so its own supply chain is a first-order risk.
- A published package cannot execute anything on install: no `bin`, no `postinstall`, no install script. The previous package published under `@sathvikc` is deprecated.

### Removed

- **The npm installer.** The previous package published under `@sathvikc` rewrote the user's registry configuration on install and added tracking files. That package is deprecated. Install the plugin from the marketplace instead:

```
/plugin marketplace add fyrlabs/groundtruth
/plugin install groundtruth@fyrlabs
```

### Notes

- This package is published for inspection and CI. It is not an installer.
- `@sathvikc/groundtruth@0.1.0` was published under MIT and is deprecated. MIT is irrevocable, so those who installed it keep those rights permanently.
