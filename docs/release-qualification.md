# v0.5 release qualification

This document distinguishes implemented automation from observed platform
evidence. A configured CI job is not recorded as passed until it executes for
the exact release-candidate commit.

| Qualification | Automation | Current evidence |
| --- | --- | --- |
| Windows, Node.js 24 | `npm run verify` on `windows-latest` | Local pre-commit run passed 772 tests and packed-artifact checks on 2026-09-16; final candidate run pending |
| macOS, Node.js 24 | `npm run verify` on `macos-latest` | Pending final candidate run |
| Linux, Node.js 24 | `npm run verify` on `ubuntu-latest` | Prior isolated Ubuntu/WSL pre-commit run passed 737 tests and packed-artifact checks on 2026-09-15; refreshed final candidate run pending |
| Packed consumer | Real tarball install in a new temporary project | Enforced by `test:package` |
| Artifact contents | Explicit allowlist, required exports and declarations | Enforced by `release:artifact` |
| Clean, partial, malformed, customized, and legacy installs | Installer and transactional upgrade integration tests | Enforced by `npm run verify` |
| Claude-only, Codex-only, and dual-provider configuration | Provider integration and configuration tests | Enforced by `npm run verify` |
| Provider readiness diagnostics | Read-only integration, executable, authentication, headless stream, event normalization, permission-level, and redaction tests | Enforced by `npm run verify` |
| Session interruption and prohibited substitution | Broker and provider-control tests | Enforced by `npm run verify` |
| Workflow dependencies, gates, budgets, retries, and routes | Workflow conformance tests | Enforced by `npm run verify` |
| Silo, Relay, and Charter adversarial behavior | SDK contract and security-oriented tests | Enforced by `npm run verify` |

Before publication, replace each pending platform entry with the workflow run
URL and exact commit SHA. Any failure reopens release qualification; it is not
waived by a passing result on another operating system.
