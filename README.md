# Orbitkeep

**Keep every agent on mission.**

`orbitkeep` is a provider-neutral control plane for governed agent work. A
Flight Director coordinates Claude Code and Codex CLI Mission Specialists
inside autonomous repository Silos. Orbitkeep supplies durable, JSON-validated
Mission state; Flight Plan Clearances and Command Authority; Docking Adapters;
generated Crew definitions; retention and archival tools; and an auditable
Flight Recorder stored in the consuming project.

It is intentionally independent of application code. Install it into each
repository that needs managed agent work; its runtime records stay in that
repository's ignored `.agent-state/` directory.

## Product status

Orbitkeep v0.4.1 is a local-first developer preview and CLI MVP. Its local
Mission governance, Claude and Codex dispatch, Flight Plans, Clearances,
Command Authority, Flight Recorder, installation repair, upgrades, retention,
and archival are implemented and validated. Multi-Silo federation, container
isolation, a hosted control plane, Mission Control, Telemetry, and multi-user
identity are planned capabilities and are not part of the current release.

The local Silo remains a supported deployment mode as the platform grows. A
future Keep coordinates Silos without replacing their authoritative local
execution history or allowing central services to infer unobserved outcomes.

## Install

The package requires Node.js 24.x.

```sh
npm install --save-dev orbitkeep
npx orbitkeep setup
```

`setup` performs transactional initialization and immediately runs the health
check. A `ready` result means the required files and configured provider
integrations are active. Existing users may continue to run `init` and
`doctor` separately.

Successful initialization reports an overall activation state and a separate
status for each configured provider. A requested provider mode is never
silently downgraded: unsupported or incomplete required integration blocks that
provider and is reported as `blocked` or `repair_required`.

For an incomplete or drifted installation, inspect the read-only repair plan
before applying it:

```sh
npx orbitkeep repair --plan
npx orbitkeep repair --apply
```

Install and repair operations are transactional. Before changing a file, the
runtime writes a journal and snapshot under the ignored
`.agent-state/installation-transactions/` directory. A failed validation rolls
the complete operation back. Malformed user-owned JSON is reported for manual
correction and is never overwritten automatically.

Inspect or recover installation transactions with:

```sh
npx orbitkeep install --status
npx orbitkeep install --recover
npx orbitkeep install --rollback
```

Rollback refuses to overwrite a file that changed after the transaction
committed. Completed transaction snapshots become cleanup-eligible after
`retention.installationBackupsDays` (30 days by default).

## Upgrade and migration

Upgrade only with the target package version already installed. Review the
versioned plan, then explicitly authorize any mutable-state migration:

```sh
npx orbitkeep upgrade --plan
npx orbitkeep upgrade --apply
npx orbitkeep upgrade --status
npx orbitkeep upgrade --rollback
```

`upgrade --apply` is the explicit authorization to apply the displayed plan,
including its registered mutable-state migrations. It does not require a
second approval flag. Library callers must still pass
`authorizeStateMigration: true` to the programmatic API.

The plan classifies files as `create`, `replace-managed`, `reconcile-shared`,
`migrate-config`, `migrate-state`, `preserve`, `manual-conflict`, or `retire`.
Only explicit one-way migrations registered by the target release may run;
v0.4.1 registers the chain from 0.3.0 through 0.4.0 and its metadata-only state
migration for the branding compatibility step. Canonical workflow records and
event history are not renamed. Other source versions stop for a manual
migration decision rather than applying an inferred transformation.
Upgrade is blocked while an assignment or execution remains active, when a
retired managed file contains user changes, or when a downgrade is requested.
Migrations may update mutable aggregate or runtime records, but never rewrite
historical daily event logs. Completion and rollback are appended as new audit
events, and each successful migration has a durable evidence record. After an
upgrade rollback, reinstall the prior package version before resuming managed
work; rollback restores repository integration state, not the npm package
selected by the consuming project.

For local development before publication:

```sh
npm pack
npm install --save-dev /absolute/path/to/orbitkeep-0.4.1.tgz
npx orbitkeep init
```

`init` creates `.agent-workflow/` configuration and immutable contract copies,
provider integration templates, and the ignored runtime-state layout. Review
the generated project configuration before enabling a provider.

## Operational model

- One installed repository is a **Silo**. It remains an autonomous local
  governance boundary even when it later connects to Mission Control.
- A **Flight Director** starts or resumes a **Mission**, records a **Flight
  Plan**, and obtains or explicitly waives the configured Executive
  **Clearance** before execution.
- The Flight Director dispatches bounded **Mission Briefs** to **Mission
  Specialists**. Specialists return structured **Mission Reports**; they do
  not change canonical workflow state.
- Mission state-changing commands require fenced **Command Authority**.
  Provider session identifiers are provenance only, not authority.
- The **Flight Recorder** uses append-only daily NDJSON event ledgers. Active
  records and archive operations are JSON-schema validated.
- The **Black Box** holds short-retention redacted provider responses;
  **Containment Bay** records preserve rejected submissions and validation
  failures; resolved workflow records enter the **Mission Archive**.

The product vocabulary maps to stable canonical v0.x record names. For
example, Mission maps to `assignment`, Operation to `task`, and Run to
`execution`. See [docs/domain-model.md](docs/domain-model.md) for the complete
hierarchy and compatibility map.

See [contracts/README.md](contracts/README.md) for the installed operating
contracts and `orbitkeep --help` for the CLI command surface. Detailed
operator guides are available in [docs/installation.md](docs/installation.md),
[docs/upgrading.md](docs/upgrading.md), and
[docs/troubleshooting.md](docs/troubleshooting.md). The extended platform plan
is maintained in [docs/roadmap.md](docs/roadmap.md).

## Development

```sh
npm ci
npm run lint
npm test
npm run build
npm pack --dry-run
npm run test:package
```

The package includes templates for both Claude Code and Codex CLI. Capability
and provider-session behavior is detected at runtime; the runtime never claims
to control a provider action without observable confirmation.

## Roadmap

- **v0.4.1 — Orbitkeep identity:** product terminology, Crew display names,
  stable compatibility aliases, and release verification.
- **v0.5 — Silo and workflow foundations:** durable Silo identity and health,
  deterministic dependency scheduling, quality gates, budgets, reusable
  workflows, Charter evaluation, Relay contracts and an in-memory reference
  transport, provider-neutral usage observations, and cross-platform
  qualification.
- **v0.6 — Mission Modules and Airlocks:** optional Docker isolation,
  per-Run worktrees, resource and secret controls, ingress/egress validation,
  consequential-action gates, result capture, cleanup, and recovery.
- **v0.7 — Relay and federation:** authenticated multi-Silo communication,
  bounded disconnected operation, remote runners, and central Flight Recorder
  replication.
- **v0.8 — Mission Control and Telemetry:** the human control interface,
  Clearances, live Mission views, analytics, alerts, and audit drill-down.
- **v1.0 — Production control plane:** stable APIs, multi-user identity,
  organization governance, signed Charter distribution, supported deployment,
  recovery, and extension contracts.

See [docs/roadmap.md](docs/roadmap.md) for scope, exit criteria, and
cross-cutting architectural rules. See
[docs/product-plan.md](docs/product-plan.md) for the product maturity model,
delivery workstreams, sequencing, risks, and unresolved platform decisions.

The local CLI remains usable without Docker. Container isolation becomes the
recommended backend when agents run concurrently, operate unattended, or need
broad tool and shell permissions.

## Compatibility

Orbitkeep retains the legacy `agent-workflow` executable alias and the existing
`.agent-workflow/` and `.agent-state/` directories in v0.4.1. Persisted schema
identifiers, record formats, and runtime actor identifiers also remain stable.
New documentation and installations use the `orbitkeep` command. The alias is
provided to make upgrades non-breaking and may be removed only in a future
major release with an explicit migration path.
