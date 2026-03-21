---
description: "Run the Groundtruth research pipeline. Accepts GitHub URLs pasted in chat or a path to a .txt file containing one URL per line. Checks PIPELINE_STATE.md on every invocation and resumes from the last incomplete stage — never restarts completed work."
---

# /analyze — Groundtruth Research Pipeline

You are the orchestrator of the Groundtruth pipeline. Your job is to coordinate all agents, manage state, handle the one human approval checkpoint, and produce the final research report.

## Pipeline Overview

```
Input URLs
    ↓
Step 0: State check — resume or start fresh?
    ↓
Step 1: Parse input + classify URLs (new vs existing)
    ↓
Step 2: Parallel start
    ├── Branch A: Clone new repos → Discovery → Triage → [PAUSE for approval]
    └── Branch B: Drift check all existing repos (background)
    ↓
Step 3: [HUMAN APPROVAL] — user approves discovery candidates
    ↓
Step 4: Analysis phase (parallelized per repo)
    Each repo: Analyzer → [Technical + Community + Conflicts verifiers in parallel] → Online spot-check
    ↓
Step 5: Reconciliation (sequential per repo)
    Each repo: Meta-reconciler → writes to report
    [PAUSE if deprecation/replacement flag raised]
    ↓
Step 6: Finalize — update registry, watchlist, report header/footer
```

---

## Step 0: State Check (ALWAYS FIRST)

Read `tracking/PIPELINE_STATE.md`.

**If status is `COMPLETE` or `IDLE`**: Start a fresh run. Proceed to Step 1.

**If status is anything else** (e.g. `AWAITING_APPROVAL`, `IN_ANALYSIS`, `RECONCILING`):
Display a resume summary:
```
Groundtruth pipeline resuming from: [status]
Run ID: [run-id]
Started: [timestamp]

Completed repos: [list]
In progress: [list]
Pending: [list]

Resuming from: [next step description]
```
Then jump directly to the appropriate step. Do not re-run completed stages.

**If status is `FAILED`**: Show the error from the Errors section. Ask the user if they want to retry the failed step or skip it.

---

## Step 1: Parse Input and Classify

### Parse input

Accept URLs in any of these formats:
- Pasted directly in chat: `https://github.com/org/repo` (one or more, space or newline separated)
- File path argument: `/path/to/urls.txt` — read the file, one URL per line, skip blank lines and `#` comments

Deduplicate. Validate that each URL matches `https://github.com/<org>/<repo>` pattern. Warn about any that don't match.

### Classify against registry

Read `tracking/REGISTRY.md`. Extract all known URLs.

Split input into:
- `NEW_REPOS`: URLs not in registry
- `EXISTING_REPOS`: URLs already in registry

### Write initial state

Update `tracking/PIPELINE_STATE.md`:
```
Status: STARTED
Run ID: groundtruth-[YYYY-MM-DD]-[NNN]  (increment NNN if multiple runs same day)
Started: [ISO timestamp]
Input URLs: [list]
New repos: [list]
Existing repos: [list]
```

---

## Step 2A: New Repos — Clone

For each URL in `NEW_REPOS`:

1. Derive repo name from URL: last path segment (e.g. `https://github.com/org/my-tool` → `my-tool`)
2. Check if `sources/my-tool/` already exists. If yes, skip cloning.
3. If no: clone via `git clone <url> sources/<repo-name>/` using Bash tool
4. Update PIPELINE_STATE.md per-repo Cloned cell: ✅ or ❌ (with error if failed)

If a clone fails, mark it ❌ in state and continue with others — do not halt the pipeline.

---

## Step 2B: Discovery (optional, runs in parallel with Step 2A)

Only run if the user invoked `/analyze` without specific URLs, or explicitly asked for discovery.

Invoke `groundtruth-discovery` agent (Haiku) via Task:
- Pass: DOMAIN (inferred from registry contents), REGISTRY_URLS, WATCH_LIST_URLS
- Receive: `DISCOVERY_CANDIDATES` block

Then invoke `groundtruth-triage` agent (Haiku) via Task:
- Pass: DISCOVERY_CANDIDATES, REGISTRY_SUMMARY, CURRENT_DATE
- Receive: `TRIAGE_RESULTS` block

Update PIPELINE_STATE.md: Discovery and Triage cells for relevant repos.

---

## Step 2C: Existing Repos — Drift Check (background, parallel)

For each URL in `EXISTING_REPOS`, invoke `groundtruth-drift-checker` (Haiku) via Task in parallel:
- Pass: REPO_NAME, REPO_PATH (sources/<repo-name>/), LAST_ANALYZED, LAST_VERSION from registry
- Receive: `DRIFT_REPORT`

Classification:
- `NO_DRIFT` → mark PIPELINE_STATE.md Drift cell ⏭️ (skipped) for all subsequent stages — this repo is done
- `MINOR_DRIFT` → queue for online-spot-checker only (skip full re-analysis)
- `MAJOR_DRIFT` → queue for full analysis pipeline

Update PIPELINE_STATE.md per-repo Drift cells as reports arrive.

---

## Step 3: Human Approval Checkpoint

**PAUSE the pipeline here.**

Display the triage results (if discovery ran) and the drift summary for existing repos:

```
═══════════════════════════════════════════════
  GROUNDTRUTH — APPROVAL CHECKPOINT
═══════════════════════════════════════════════

NEW REPO CANDIDATES — ready to enter pipeline:
  ✓ https://github.com/org/repo-a
    Why: solves X which no registry repo addresses
  ✓ https://github.com/org/repo-b
    Why: significant improvement over existing-tool

WATCH LIST — not ready yet:
  ~ https://github.com/org/repo-c
    Why: only 2 weeks old, no release yet
    Check again: 2026-04-21

REJECTED — filtered out:
  ✗ https://github.com/org/repo-d
    Why: fork of existing-tool with no meaningful changes

EXISTING REPOS — drift summary:
  → 3 repos: no drift (will be skipped)
  → 2 repos: major drift (will be fully re-analyzed)
  → 1 repo: minor drift (online spot-check only)

═══════════════════════════════════════════════
Approve pipeline candidates? [yes / no / edit]
```

Wait for user response.
- `yes`: proceed
- `no`: stop pipeline, set status IDLE
- `edit`: user can remove specific repos from the list before proceeding

Update PIPELINE_STATE.md: `Approval: APPROVED`, `Approval timestamp: [ISO timestamp]`

If discovery did not run (user provided specific URLs), skip the discovery part of this display and just show drift summary. Still pause for acknowledgment.

Note: if discovery results are older than 7 days (check discovery timestamp in state), warn: "⚠️ Discovery was run N days ago — candidates may be stale. Consider re-running discovery."

---

## Step 4: Analysis Phase

For each repo in the approved analysis queue (new repos + major-drift existing repos):

### Per-Repo Analysis (invoke in parallel across repos, sequential within a repo):

**4a. Invoke `groundtruth-analyzer` (Sonnet) via Task**
- Pass: REPO_NAME, REPO_PATH, REPO_URL, ANALYSIS_DATE
- Receive: `ANALYSIS_REPORT`
- Update PIPELINE_STATE.md: Analyzer cell ✅

**4b. Invoke three verifiers IN PARALLEL via Task (after 4a completes):**
- `groundtruth-technical-verifier` (Sonnet): Pass ANALYSIS_REPORT, REPO_PATH
- `groundtruth-community-verifier` (Sonnet): Pass ANALYSIS_REPORT, REPO_PATH, REPO_URL
- `groundtruth-conflicts-verifier` (Sonnet): Pass ANALYSIS_REPORT, REPO_PATH, REGISTRY_SUMMARY
- Update PIPELINE_STATE.md: Tech-V, Comm-V, Conf-V cells as each completes

**4c. Invoke `groundtruth-online-spot-checker` (Haiku) via Task (after 4b completes):**
- Pass: REPO_NAME, REPO_URL, DRIFT_REPORT (or "NEW_REPO"), KEY_CLAIMS from analysis
- Receive: `ONLINE_SPOT_CHECK`
- Update PIPELINE_STATE.md: Online cell ✅

For minor-drift repos: invoke only `groundtruth-online-spot-checker` — skip 4a and 4b.

---

## Step 5: Reconciliation Phase

**Sequential per repo** (one meta-reconciler at a time to avoid concurrent writes to report file).

For each completed repo (in alphabetical order by repo name):

**5a. Check for human approval flags**
If ONLINE_SPOT_CHECK or COMMUNITY_VERIFICATION raised a `⚠️ DEPRECATION WARNING` or `⚠️ REPLACEMENT` flag:
```
═══════════════════════════════════════════════
  HUMAN APPROVAL REQUIRED
═══════════════════════════════════════════════
  Repo: <repo-name>
  Flag: [deprecation/replacement details]
  Source: [where the signal came from]

  Options:
    1. Mark as deprecated in report
    2. Mark as replaced by [other-repo]
    3. Keep current status (ignore flag)
    4. Skip this repo for now
═══════════════════════════════════════════════
```
Wait for user choice before proceeding.

**5b. Invoke `groundtruth-meta-reconciler` (Opus) via Task:**
- Pass: all five blocks + REPORT_PATH + EXISTING_REGISTRY_ENTRY
- Meta-reconciler appends repo profile to report
- Update PIPELINE_STATE.md: Meta-R cell ✅, Done cell ✅

---

## Step 6: Finalize

After all repos are reconciled:

**6a. Update report header**
Read the report file, update the header fields: Generated date, Repos analyzed count, Repos skipped count.

**6b. Write report summary sections**
Invoke `groundtruth-meta-reconciler` one final time (Opus) with a special prompt:
- "Write the Executive Summary, Comparative Analysis, and Appendix sections of the report based on all repo profiles written so far"

**6c. Update REGISTRY.md**
For each newly analyzed repo, append a registry entry. For updated repos, update the Last analyzed, Last version, Stars (live), and Last commit fields.

**6d. Update WATCH_LIST.md**
Add any new watch list entries from triage. For existing watch list entries, update Last checked date.

**6e. Update PIPELINE_STATE.md**
Set status: `COMPLETE`. Record completion timestamp.

**6f. Final summary to user**
```
═══════════════════════════════════════════════
  GROUNDTRUTH — PIPELINE COMPLETE
═══════════════════════════════════════════════

  Run ID: groundtruth-[YYYY-MM-DD]-[NNN]
  Duration: ~N minutes

  Repos newly analyzed: N
  Repos re-analyzed (drift): N
  Repos skipped (no drift): N
  Repos added to watch list: N

  Report: output/groundtruth-report.md
  Registry: tracking/REGISTRY.md

  Human flags raised during run: N
  Contradictions resolved: N

  Drop output/groundtruth-report.md into any project
  for instant research context.
═══════════════════════════════════════════════
```

---

## Error Handling

If any agent fails (Task returns error):
1. Mark the failed cell in PIPELINE_STATE.md as ❌
2. Log the error in the Errors section of PIPELINE_STATE.md
3. Continue with other repos in the queue — do not halt the pipeline
4. At the end of the run, report which repos have incomplete analysis

When user runs `/analyze` again after a failure:
- Resume from failed stage for the affected repo
- All completed repos are already in the report — do not re-run them

## Sources Folder Check

Before starting any analysis, verify: is `sources/` being tracked by git?
```bash
git ls-files sources/ | head -5
```
If any cloned repo files appear (not just `.gitkeep`): warn the user and suggest adding `sources/*/` to `.gitignore`.
