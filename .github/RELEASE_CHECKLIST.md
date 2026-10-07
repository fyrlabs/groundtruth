# Release checklist

Work top to bottom. Every item here exists because something went wrong once; the parenthetical says what. Do not skip an item because it looks obvious, especially the ones that only fail in a published artifact.

The notes body template is in [RELEASE_TEMPLATE.md](RELEASE_TEMPLATE.md).

## 1. Before you touch a version number

- [ ] `main` is green on every CI job.
- [ ] `npm run verify` passes from a clean checkout (`npm ci`, not a warm `node_modules`).
- [ ] `claude plugin validate .` is clean.
- [ ] `npm pack --dry-run` lists every directory the manifest references. `verify:layout` asserts it,
      but it cannot see a file that npm silently drops, so read the listing.
- [ ] No absolute home path from a maintainer's machine is tracked. The repository is public, and
      generated trees are how such a path gets in:

```bash
git ls-files -z | xargs -0 grep -nlI -e '/Users/' -e '/home/' -e '$HOME'
```

- [ ] **The empirical plugin probe has been run against the commit being released**, not against an
      earlier one. A scratch copy loaded with `--plugin-dir` must register all nine agents and resolve
      both `/groundtruth` and `/groundtruth:analyze`. Reading documentation does not catch a
      double-prefixed agent name or a dead command; the probe did, twice.

```bash
git archive HEAD | tar -x -C /tmp/gt-probe
claude --plugin-dir /tmp/gt-probe -p "List every agent and slash command this plugin provides."
```

## 2. Versions

- [ ] `package.json` bumped, and `.claude-plugin/plugin.json` matches it. CI asserts they agree.
- [ ] `.claude-plugin/marketplace.json` `metadata.version` is deliberately still `1.0.0`. That field
      versions the *marketplace*, not the plugin; do not bump it with releases.
- [ ] No file hard-codes a version. `grep -rn "0\.[0-9]\.[0-9]" --include="*.mjs"` should only find
      versions inside test fixtures.
- [ ] `CHANGELOG.md` has an entry, and nothing user-visible is missing from it.
- [ ] Breaking changes are called out in the changelog **and** in the release notes.

## 3. Docs match the code

- [ ] `AGENTS.md` still describes the real layout and the real gate list.
- [ ] `EVALUATION.md` numbers match reality — the test count and the layout invariant count are both
      easy to leave one behind when a change adds either.
- [ ] `SECURITY.md` claims nothing the code stopped doing. It is a threat model, so a removed control
      is a change to it, not a leftover sentence.
- [ ] Anything changed in behaviour, schema or agent prompts is documented in the same commit.

## 4. The thing that is never done and always should be

- [ ] Run the pipeline against at least one real repository, and read the report rather than the exit
      code. Every defect found during development of the quote validator came from doing this: a
      partial clone accepted as intact, a payload written outside state, a stage name nothing wrote,
      and four fabricated claims that passed every check. CI cannot find any of them, because all four
      are properties of a real repository rather than of a fixture.

## 5. Tag and publish

- [ ] `NPM_TOKEN` is present in the repository secrets and is **read-write for the `@fyrlabs` scope**.
      (An unauthorised publish returns `E404 PUT`, which reads like a missing package and is not.)
- [ ] Tag name and GitHub release title are both `vX.Y.Z`. No `groundtruth` prefix.

Publishing the GitHub release is what publishes to npm; the tag on its own does nothing. Push the tag
whenever a version is worth marking, and come back for the second half when it has earned a release.

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z                                    # a candidate, nothing is published yet

gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes>   # this publishes
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

The workflow skips a version already on the registry, so re-running a failed release is safe. If the
release exists but its run failed, re-run it with
`gh workflow run release.yml -f ref=vX.Y.Z` rather than re-tagging.

## 6. Verify the published artifact, not the green check

**A green CI run proves the tests passed. It does not prove the tarball is right.** The npm package
exists for inspection and CI, not as an installer — the plugin is installed from the marketplace — so
the artifact to check is the one people will read.

```bash
npm view @fyrlabs/groundtruth version license deprecated
npm view @fyrlabs/groundtruth dependencies   # must print nothing: zero runtime dependencies is a
                                              # deliberate supply-chain choice, not an accident
```

- [ ] Version and `Apache-2.0` are what the release claims.
- [ ] Provenance shows on the npm package page.
- [ ] The tarball contains `LICENSE` and `NOTICE`, and **no** `bin`, no `postinstall`, and no
      `install.js`. `@sathvikc/groundtruth@0.1.0` rewrote the user's npm registry config and installed
      tracking files; the single most important property of this package is that installing it cannot
      do anything.

```bash
npm pack --dry-run | grep -E "bin/|install\.js|postinstall|tracking/"   # must print nothing
```

## 7. Clean up

- [ ] Tags and releases line up. Every released version keeps its tag and its release page; that history
      is the point. Delete a tag only when it never had a release, or when its artifact is broken and
      withdrawn.

```bash
git push origin :refs/tags/vOLD && git tag -d vOLD
```

- [ ] Deprecate a version only if it is **actually bad**, not merely superseded. Deprecating every
      previous release trains people to ignore the warning. When you do, deprecate rather than
      unpublish: deprecation is reversible, unpublishing is not, and a version number can never be
      reused.

```bash
npm deprecate @fyrlabs/groundtruth@X.Y.Z "superseded by A.B.C" --otp=<code>
```

Deprecation takes tens of seconds to show on the registry. Checking immediately shows the version still
active; that is lag, not failure.

- [ ] If you must unpublish: `npm unpublish` **always** demands an OTP, so it can never run unattended,
      and it returns `E422 Unprocessable Entity` when you fire several in a row. Retry with a fresh
      code. Never unpublish every version of a name; that blocks republishing it for 24 hours.