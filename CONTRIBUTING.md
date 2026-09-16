# Contributing to Orbitkeep

Orbitkeep requires Node.js 24 and npm. Start from a focused branch, install the
locked dependencies, and run the complete verification gate:

```sh
npm ci
npm run verify
```

Keep changes narrow and add tests for behavior, failure modes, and recovery.
When a public contract changes, update its TypeScript interface, JSON Schema,
materialized schema registry, package export test, documentation, and changelog
together. Generated Claude and Codex Crew definitions must remain equivalent;
run `npm run roles:check` before committing.

Do not commit `.agent-state`, credentials, provider transcripts, private keys,
ownership tokens, or signed approval receipts. Report suspected vulnerabilities
using [SECURITY.md](SECURITY.md), not a public issue.

Pull requests should explain the user-visible outcome, compatibility impact,
tests run, and any remaining platform qualification. A passing test on one host
must not be described as cross-platform qualification.
