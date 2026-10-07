## What this changes

<!-- What the change does and why. Describe the behaviour as it now is, not the diff. -->

## Why

<!-- The problem being solved. If it fixes an issue, link it: Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation
- [ ] Refactor, performance or tooling

## Breaking changes

<!-- If you ticked "Breaking change": what breaks, and what a user has to do about it.
     Payload schemas, evidence tiers, agent names and the CLI surface are all public
     contract. Write "None" if nothing breaks. -->

None.

## Testing

<!-- What you ran, and what a reviewer should run to see it work.
     A test that would have caught the bug is worth more than a test that covers the fix. -->

- [ ] `npm run verify` passes
- [ ] New or changed behaviour has a test that fails without the change
- [ ] Security-relevant changes have a test using the shape that **defeats a naive implementation** —
      tilde expansion, unquoted paths, loosely written flags, symlinked roots, alternate interpreters.
      Several guards in `guard-bash.mjs` carry a comment naming the exact attack that defeated the
      previous revision, because the obvious pattern silently passed.

## Checklist

- [ ] Commits follow Conventional Commits: `type(scope): subject`, scopes from `AGENTS.md`
- [ ] Every artifact the change type requires is in the **same commit** — see the matrix in `AGENTS.md`
- [ ] `scripts/verify-layout.mjs` extended **in the same commit** if a component was added or a layout moved
- [ ] `CHANGELOG.md` updated if a user could observe the difference
- [ ] `docs/design-decisions.md` entry added for any new semantics, and **not** for typo fixes
- [ ] `EVALUATION.md` numbers updated if tier logic or a prompt changed
- [ ] No secrets, tokens or absolute local paths in the diff
- [ ] Repositories remain hostile input: no guard weakened to make a stage easier

## Notes for the reviewer

<!-- Anything worth knowing: a decision you were unsure about, an alternative you
     rejected, the part most likely to be wrong. -->