# Changelog

Notable changes to Orbitkeep are documented here. The project follows semantic
versioning while it is in developer preview; minor v0.x releases may change the
public API when the migration is documented.

## [0.5.0] - Unreleased

### Added

- Headless Claude Code and Codex CLI adapters with normalized JSON event
  streaming, canonical Run outcomes, and automatic Mission Report submission.
- An authenticated per-Silo local supervisor with detached execution, durable
  job discovery, lease renewal, duplicate-run prevention, safe and forced
  shutdown, configurable idle exit, and Windows process-tree termination.
- Provider-neutral `mission` controls for planning, approval, status, logs,
  questions, steering, pause, resume, stop, handover, and explicit Executive
  Mission Report acceptance and closure.
- Read-only `provider doctor` diagnostics for integration, executable,
  authentication, headless streaming, event normalization, and permission
  control readiness without exposing provider account details.
- Durable Silo identity, lifecycle, capability, health, registration, and key
  metadata SDK contracts.
- Deterministic workflow scheduling, dependencies, quality gates, budgets,
  retries, conditional routes, and reusable workflow templates.
- Signed, ordered, idempotent Relay contracts and an in-memory reference
  transport.
- Local and central Charter validation, trust, intersection, and managed Run
  dispatch enforcement.
- Explicit npm artifact policy, packed-consumer smoke test, and Windows,
  macOS, and Linux CI qualification matrix.

### Changed

- Provider integrations now require brokered Mission context when enforcement
  is enabled and fail closed when authorization cannot be established.
- `session launch --provider ...` is retired and no longer launches a provider;
  users remain in Orbitkeep's parent control channel.
- Setup, repair, and upgrade use transactional installation behavior and
  human-readable terminal output with explicit `--json` automation output.
- Headless Claude Missions use an Orbitkeep-owned isolated settings source, so
  preserved repository hooks cannot block or replace managed provider output;
  diagnostics report both managed and project hook sets.
- Observational Claude hooks now persist their acknowledgements silently and
  emit stdout only for documented permission decisions, preventing hook audit
  metadata from entering provider context or replacing final responses.
- Claude hooks now use a framework-managed direct Node runner instead of an
  `npx`/PowerShell shim per event, preventing visible console-window churn on
  Windows and making the installed runner independently repairable.
- Background Mission activity now uses a bounded per-job JSONL stream. Mission
  log reads no longer open every legacy raw-response file concurrently, and
  raw provider-response persistence remains disabled unless explicitly enabled.
- Human Mission status, activity, stop, and supervisor-control guidance now
  exposes useful progress and recovery actions without requiring JSON output.

### Security

- Provider bootstrap is secret-bound and narrowly restricted until a Mission
  has approved Command Authority.
- Managed providers cannot approve their own Flight Plans or accept their own
  Mission Reports; result acceptance remains an explicit parent-channel action.
- Package publication rejects dirty, out-of-sync, unversioned, or structurally
  incomplete release candidates.

[0.5.0]: https://github.com/awohlford1/orbitkeep/releases/tag/v0.5.0
