# Contributing

Groundtruth reads repositories it does not control and hands what it finds to language models. That
shapes what a change needs to be trusted: most of the work here is proving a claim holds against
input designed to break it.

Read [AGENTS.md](AGENTS.md) first — it is the process contract, including the artifact matrix and
what each kind of change requires. This file is the mechanics.

## Setup

Zero runtime dependencies, so there is nothing to install to run it.

```bash
node --version          # 20.11+
npm run verify          # layout invariants, frontmatter lint, tests
claude plugin validate .
```

## The loop

```bash
npm run verify:layout   # while adding agents, skills, or scripts
npm run verify:frontmatter
npm test
npm test injection     # the hostile-repository suite
npm test state
npm test render
npm test hooks
```

Run `verify:layout` **before** committing anything that touches layout. It catches the class of bug
this project shipped its entire first version with: components that exist and are internally correct
but that nothing can actually reach.

## Testing what you cannot see

Some failures here are invisible to the unit test and obvious only in a real harness. When you change
discovery, frontmatter, or packaging, confirm empirically:

```bash
# does the plugin actually register what it claims?
claude --plugin-dir . -p "List every custom subagent name, then every skill name." --output-format text
```

Read the output. If an agent you added is not listed under `groundtruth:<name>`, nothing in the test
suite will tell you — but the pipeline is dead in exactly the same way it was before.

## Writing a guard

The guards in `scripts/guard-*.mjs` exist because naive implementations of them were wrong. Several
have a comment recording the attack that defeated the previous revision. When you extend one, write
the test with the shapes that defeat the obvious pattern:

- tilde expansion (`~`, `$HOME`, an absolute path — pick all three, not one)
- unquoted and oddly quoted paths
- loosely written flags (`git -C` vs `cd && git`, `-rf` vs `-R --force`)
- symlinked roots — macOS resolves `/tmp` to `/private/tmp`, so string comparison silently fails
- alternate interpreters, not just `sh`
- redirects with and without a leading space

Then run the test before and after your change. A guard that passes everything on the first try is
usually not testing anything.

## Adding an agent

See AGENTS.md. The short version:

- `tools` grants only what the body uses; `verify-layout.mjs` checks both directions
- state the evidence surface **and what must not be read** — overlapping surfaces are what make
  verifier agreement meaningless
- `omitClaudeMd: true`, always
- no `Write` or `Edit`: payloads go through `scripts/write-payload.mjs`
- if it reads attacker-controlled content, include the untrusted-content preamble and say where
  detections get recorded
- `model` is a tier alias, never a full ID

## Adding a decision

Not every change needs one. Add an entry to `docs/design-decisions.md` when semantics change, a
guarantee is established, or a tradeoff is settled — and only if a user could observe the difference.

The format is Decision / Reasoning / Alternatives considered / Tradeoff. The reasoning is the part
that matters; a future reader reconstructing *why* is the entire value.

## Commits

Conventional commits. One logical change per commit, carrying every artifact it needs — a commit
should be revertable as a unit.

The body explains **why**, and records the attack or failure mode that motivated a fix. That is the
part a reader cannot reconstruct from the diff. One item per line, however long; never hard-wrap.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](SECURITY.md) — a hostile fixture repository is far more
useful than a description.

## Honest evaluation

If you change tier logic or a prompt, update `EVALUATION.md` — including if the result is worse.
This project asserts that its tiers mean something; that claim is only worth anything if it gets
measured, and a null result published honestly is more useful than a favourable number nobody checked.