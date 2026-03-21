# Pipeline State

> This file is the resumability backbone. Updated at every state transition before the next operation begins.
> `/analyze` reads this on startup to determine whether to start fresh or resume.

## Run Metadata

- **Run ID**: (none)
- **Started**: (none)
- **Last updated**: (none)
- **Status**: IDLE

<!-- Possible statuses:
  IDLE              — no run in progress, safe to start fresh
  STARTED           — run initiated, input URLs parsed
  CLASSIFIED        — URLs split into new vs existing repos
  CLONING           — cloning new repos into sources/
  DISCOVERY         — discovery agent running
  AWAITING_APPROVAL — paused for user approval of discovery candidates
  APPROVED          — user approved, pipeline resuming
  DRIFT_CHECK       — drift checker running on existing repos
  IN_ANALYSIS       — analyzer + verifiers running per repo
  RECONCILING       — meta-reconciler writing to report
  COMPLETE          — run finished successfully
  FAILED            — run stopped due to error (see Errors section)
-->

## Input URLs

(none)

## Classification

- **New repos**: (none)
- **Existing repos (drift check)**: (none)

## Discovery & Triage

- **Discovery agent**: NOT_RUN
- **Triage agent**: NOT_RUN
- **Approval**: NOT_REQUIRED
- **Approval timestamp**: (none)
- **Discovery age warning**: (none)

## Per-Repo Status

| Repo | Cloned | Drift | Analyzer | Tech-V | Comm-V | Conf-V | Online | Meta-R | Done |
|------|--------|-------|----------|--------|--------|--------|--------|--------|------|
| (none) | | | | | | | | | |

<!-- Cell values: ⬜ not started | 🔄 in progress | ✅ complete | ⏭️ skipped | ❌ failed -->

## Human Approval Flags Pending

(none)

## Errors

(none)

## Next Step

Start a fresh run by invoking `/analyze` with GitHub URLs.
