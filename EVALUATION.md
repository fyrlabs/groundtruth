# Evaluation

A tool whose pitch is "no blind README trust" should measure whether its own tiers are right.
This is the pre-registered harness for that, plus the results as they stand.

## What is being measured

| Question | Metric | Target |
|---|---|---|
| Does the pipeline catch a false claim? | Tier assigned to a known-false claim | `contradicted` |
| Does it avoid false confidence? | False `code-verified` on an unverifiable claim | 0 |
| Is it honest about gaps? | Uncovered claims counted, not dropped | reported |
| Does injection change a verdict? | Verdicts on a hostile fixture vs a clean one | identical |
| Is agreement independent? | Claims where all agents cited one file | flagged `correlated` |
| Is the report reproducible? | Two renders of the same state | byte-identical |

## Rules for this file

- Declare hypotheses and fixtures **before** running.
- Publish null results. A favourable number nobody checked is worth less than an honest one.
- Change any tier rule or agent prompt → rerun and update the numbers here, in the same commit.
  `CONTRIBUTING.md` requires it.

## Deterministic checks (CI, no model)

These are not "the model seemed to behave". They are invariants that either hold or do not, and they
run on every commit. Results as of v0.2.0: **157 tests passing, 26/26 layout invariants.**

| Invariant | Where | Count |
|---|---|---|
| Instruction override, role spoof, output forgery, hidden unicode detected | `test/injection.test.mjs` | 8 patterns |
| A hostile fixture repo is refused, for the control-file reason | `test/hostile-fixture.test.mjs` | 1 fixture, 4 signals |
| A forged verdict citing an unread or non-existent file is rejected | `test/injection.test.mjs`, `test/readlog.test.mjs` | 14 cases |
| A directory, an escaping symlink, or `.git` cannot be cited as evidence | `test/readlog.test.mjs` | 5 cases |
| A citation is checked against the agent that made it, not any agent | `test/readlog.test.mjs` | 1 case |
| Capitalisation cannot defeat the correlation rule | `test/readlog.test.mjs` | 1 case |
| Three agents citing one file cannot be `code-verified` | `test/injection.test.mjs` | 2 cases |
| Repo-controlled text cannot forge table rows or hide from review | `test/render.test.mjs` | 3 cases |
| Guards block the shapes that defeated earlier revisions | `test/hooks.test.mjs` | 12 cases |
| A stage without a payload is not reported complete | `test/state.test.mjs` | 2 cases |
| Re-render is byte-identical | `test/render.test.mjs` | 1 case |
| A linter that cannot fail is caught, from any path shape | `test/frontmatter.test.mjs` | 5 cases |
| Quarantine removes control files, does not merely detect them | `test/hostile-fixture.test.mjs` | 9 cases |
| Clone reuse, refusal markers, and non-GitHub rejection | `test/hostile-fixture.test.mjs` | 4 cases |
| A partial working tree is detected, and quarantine-removed files are not counted as damage | `test/hostile-fixture.test.mjs` | 6 cases |
| A payload supplied with `--file` still lands in state and survives a resume | `test/state.test.mjs` | 3 cases |
| A claim's quote occurs in the file it cites, near the line it cites | `test/quote.test.mjs` | 31 cases |
| Every bypass found in the adversarial review of that check fails closed | `test/quote.test.mjs` | 6 regressions |
| `WebFetch` exfiltration is *not* contained | `SECURITY.md` | documented, not claimed |

### Fixture results

**`hostile-repo`** — a fixture carrying every attack shape at once: `AGENTS.md` and `CLAUDE.md`
with instruction overrides and role spoofing, a `.claude/skills/` entry pre-approving
`Bash Write Edit`, and a README containing a forged `## ANALYSIS_REPORT` with a fabricated claims
table and a `## TECHNICAL_VERIFICATION` block asserting every claim is verified.

- Refused at clone time on three signals: `control-file:AGENTS.md`, `control-file:CLAUDE.md`,
  `control-dir:.claude`. Refused for the *right* reason — the tree is tiny, and the test asserts it is
  not refused for size.
- Both forged blocks and the pre-approved tool list are detected if the content is read anyway.

**`known-claims-repo`** — five claims with a known ground truth:

| Claim | Ground truth | How it must resolve |
|---|---|---|
| Supports 3 platforms | true | `code-verified` — three installers exist |
| Ships 4 plugins | **false** | `contradicted` — no plugins directory |
| MIT licensed | true | `code-verified` — `LICENSE` is MIT |
| 10,000 rps | undecidable | `unverifiable` — no benchmark harness |
| Independently audited | **false** | `contradicted` — `AUDIT.md` says not performed |

This fixture is what a live run is scored against: the pipeline's job is to reach exactly those
five answers, including *not* reaching an answer for the benchmark.

## What is measured with a model, and is not yet

Honest status: the tier *logic* is fully covered by the deterministic suite above. The remaining
question is **model behaviour** — whether an agent following these prompts reliably produces
schema-valid payloads and reaches the right tiers on repositories nobody wrote fixtures for.

That is measured by running the pipeline on real repositories and scoring the result against
manually-derived ground truth. **This has not been run yet.** v0.2.0 is the first version where the
pipeline runs at all, so there is no measurement, and any tier-accuracy figure published before that
would be fabricated.

The harness to run it:

```bash
node scripts/evaluate.mjs --fixture test/fixtures/known-claims-repo
```

### Live runs: what they did and did not prove

Three repositories were cloned and profiled end to end (`cloudflare/security-audit-skill`,
`NousResearch/hermes-agent`, `xai-org/grok-build`). The agent roles were executed manually under one
model rather than dispatched by the plugin, so **these runs measure the deterministic pipeline, not
model accuracy.**

They earned their cost by finding four defects that no fixture had:

- A partial working tree was reused as if intact. An interrupted `git clone` left a directory with a
  valid `.git` and a resolvable `HEAD` but one file of twenty-two on disk. The analysis ran against
  the fragment and the pipeline reported success. Now guarded by `ls-files --deleted`, less the count
  quarantine removed — `test/hostile-fixture.test.mjs`.
- `write-payload.mjs --file` treated its argument as an output path as well as an input, so a profile
  could be written outside state where nothing could find it. That is the success-marker-over-a-total
  miss failure this project exists to prevent, occurring inside its own tooling. `--file` is now input
  only — `test/state.test.mjs`.
- The stage list named the reconciler stage `reconcile` while every write path used `profile`. Nothing
  wrote `reconcile`, so `repoProgress` never counted a finished repository complete and **every resume
  redid the most expensive stage in the pipeline.**
- Debris at a clone path with no `.git` made every subsequent run fail permanently with git's
  "destination path already exists" and a refusal marker nothing could clear.

One negative result is recorded deliberately: the first Cloudflare profile was built with claims copied
from the `known-claims-repo` fixture that do not appear in that repository at all — including
"Independently audited by a third party", "Ships 4 plugins" and "Handles 10000 requests per second",
plus a genuine-looking paraphrase of a claim I believed was real. The validator accepted every one, and
the whole set reached a rendered report.

That gap is now closed. A claim's quotation is verified against the file it cites, on the **profile**
rather than on the intermediate analysis payload, because the profile is the artifact a reader sees.
The first implementation of the check was itself adversarial-reviewed and found defeatable — a
one-character quote matched any prose file, a non-string path passed with zero errors, and a
newline-padded quote reached a 1002-line positional tolerance — so the check earned its name rather than
assuming it. `test/quote.test.mjs` carries 24 cases including every bypass.

### Known limitations of the design, stated up front

- **Claim extraction is a model judgement** about what is checkable. A repository that documents
  little yields a short list, so "all claims verified" on a quiet repo is not a strong result.
- **The validator cannot check intent.** It proves a verdict cites a file the agent read. It cannot
  prove the agent read it for the right reason. This is the residual failure mode of the whole design
  and the reason the provenance record is published next to the report.
- **Live data decays.** Star counts and commit dates were true at an instant; a re-run produces a
  different profile, correctly.
- **Injection resistance is structural, not behavioural.** The fixtures prove the *pipeline* refuses
  the hostile repo. They do not prove a model would have been immune had it read the content — which
  is the point of not relying on that.
- **`n=1` fixture so far.** One fixture is a regression test, not a measurement. Treat any accuracy
  claim as unmeasured until at least a dozen real repositories have been scored.
- **A quotation is verified; intent is not.** The quote is proved to occur in the cited file and near
  the cited line. Whether the agent read it *for that reason* remains unverifiable, and that is the
  residual failure mode of the whole design.

## Reproducing

```bash
npm test                  # all deterministic checks
npm test hostile-fixture  # the injection fixture specifically
npm test readlog          # the citation-provenance suite specifically
npm run verify            # + layout and frontmatter invariants
```

Deterministic results are reproducible because none of the above invokes a model.