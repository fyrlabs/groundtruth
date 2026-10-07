# Release template

The body used for a GitHub release. Copy the block below into the notes and fill it in from `CHANGELOG.md`.

**The checklist that has to pass before tagging lives in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).** It is kept separate and single-sourced so the two cannot drift apart.

One package: `@fyrlabs/groundtruth`. The tag name and the release title are both `vX.Y.Z`, with no `groundtruth` prefix, and they track the package version.

## Install

This package is **not an installer**. It is published for inspection and CI; the plugin itself is installed from the marketplace:

```
/plugin marketplace add fyrlabs/groundtruth
/plugin install groundtruth@fyrlabs
```

Say this in the notes. The previous package under `@sathvikc` was an installer, and it rewrote the user's npm registry config on install — a reader who assumes the new package behaves the same way is wrong in the way that matters most.

## Release notes body

```markdown
<!-- One or two sentences: what this release is, and who should care. -->

### Breaking changes

<!-- What breaks and what to do about it. Write N/A if there are none; do not delete the section. -->

### Added

### Changed

### Fixed

### Licence

Apache-2.0. `LICENSE` and `NOTICE` ship with the package.

**Full changelog:** https://github.com/fyrlabs/groundtruth/blob/main/CHANGELOG.md
```

## After publishing

- [ ] `@fyrlabs/groundtruth` resolves on npm at the new version, with `Apache-2.0`
- [ ] `npm view @fyrlabs/groundtruth dependencies` prints nothing
- [ ] Provenance shows on the npm package page
- [ ] The tarball has no `bin`, no `postinstall` and no `install.js`
- [ ] Tags and releases still line up: every released version keeps its tag and its release page
- [ ] A new `## [Unreleased]` section opened in `CHANGELOG.md`