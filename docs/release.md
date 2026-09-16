# Release procedure

Releases are produced from an exact reviewed commit on `main` with Node.js 24.
The npm artifact, not the working directory, is the release unit.

## Candidate qualification

1. Fetch the remote and confirm local `main` is at its configured upstream.
2. Confirm `package.json`, `package-lock.json`, `src/version.ts`, and the
   changelog identify the same version.
3. Run `npm ci` and `npm run release:check` from a clean working tree.
4. Confirm the GitHub Actions Windows, macOS, and Linux verification jobs pass
   for the exact candidate commit.
5. Inspect `npm pack --dry-run --json --ignore-scripts`. Internal
   specifications, source, tests, local state, credentials, and archives must
   not be present.

`npm run release:artifact` is safe during development and CI. It validates the
packed file allowlist, executable and export targets, TypeScript declarations,
version metadata, size, and entry-count limits. `npm run release:check` adds the
publication-only Git requirements: clean `main`, matching upstream commit, and
an unused local version tag.

## Publish

After all candidate jobs pass:

```sh
npm publish --access public
```

Complete npm authentication and OTP interactively. Never place an npm token or
OTP in repository files, command history, logs, or Orbitkeep state. Verify the
published package from a new empty consumer project before creating and pushing
the `v<version>` tag and GitHub release.

If publishing fails before npm accepts the package, correct the cause and rerun
the complete release check. npm versions are immutable; if the registry accepts
a broken artifact, do not overwrite it. Deprecate it if necessary, increment
the version, and publish a corrected artifact.
