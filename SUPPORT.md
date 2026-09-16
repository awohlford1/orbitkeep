# Support

Orbitkeep v0.5 is a local-first developer preview for Node.js 24 on Windows,
macOS, and Linux. Claude Code and Codex CLI remain separately installed and
authenticated provider dependencies; Orbitkeep detects their capabilities but
does not install, authenticate, or silently substitute them.

Use [GitHub issues](https://github.com/awohlford1/orbitkeep/issues) for
reproducible defects and installation problems. Before filing an issue, run:

```sh
npx orbitkeep doctor --json
npx orbitkeep install --status --json
```

Include the Orbitkeep version, Node.js version, operating system, provider
selection, failing command, stable error code, and a minimal reproduction.
Redact usernames, repository content, credentials, private keys, ownership
tokens, approval receipts, raw responses, and `.agent-state` records.

Feature requests are welcome, but the v0.x public API may change between minor
versions with release notes and an explicit migration path. Production service
levels, long-term-support releases, and a hardened container execution boundary
are not yet offered.
