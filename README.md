# Agent Workflow

`@agent-workflow/cli` is a provider-neutral workflow runtime for managers that
coordinate Claude Code and Codex CLI specialists. It supplies durable,
JSON-validated assignment state; plan approval and ownership controls;
provider adapters; generated role definitions; retention and archival tools;
and an auditable event ledger stored in the consuming project.

It is intentionally independent of application code. Install it into each
repository that needs managed agent work; its runtime records stay in that
repository's ignored `.agent-state/` directory.

## Install

The package requires Node.js 24.x.

```sh
npm install --save-dev @agent-workflow/cli
npx agent-workflow setup
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
npx agent-workflow repair --plan
npx agent-workflow repair --apply
```

Install and repair operations are transactional. Before changing a file, the
runtime writes a journal and snapshot under the ignored
`.agent-state/installation-transactions/` directory. A failed validation rolls
the complete operation back. Malformed user-owned JSON is reported for manual
correction and is never overwritten automatically.

Inspect or recover installation transactions with:

```sh
npx agent-workflow install --status
npx agent-workflow install --recover
npx agent-workflow install --rollback
```

Rollback refuses to overwrite a file that changed after the transaction
committed. Completed transaction snapshots become cleanup-eligible after
`retention.installationBackupsDays` (30 days by default).

## Upgrade and migration

Upgrade only with the target package version already installed. Review the
versioned plan, then explicitly authorize any mutable-state migration:

```sh
npx agent-workflow upgrade --plan
npx agent-workflow upgrade --apply
npx agent-workflow upgrade --status
npx agent-workflow upgrade --rollback
```

`upgrade --apply` is the explicit authorization to apply the displayed plan,
including its registered mutable-state migrations. It does not require a
second approval flag. Library callers must still pass
`authorizeStateMigration: true` to the programmatic API.

The plan classifies files as `create`, `replace-managed`, `reconcile-shared`,
`migrate-config`, `migrate-state`, `preserve`, `manual-conflict`, or `retire`.
Only explicit one-way migrations registered by the target release may run; the
0.4.0 release registers migration from 0.3.0. Other source versions stop for a
manual migration decision rather than applying an inferred transformation.
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
npm install --save-dev /absolute/path/to/agent-workflow-0.4.0.tgz
npx agent-workflow init
```

`init` creates `.agent-workflow/` configuration and immutable contract copies,
provider integration templates, and the ignored runtime-state layout. Review
the generated project configuration before enabling a provider.

## Operational model

- A Manager starts or resumes an assignment, records a plan, and obtains or
  explicitly waives the configured Executive approval before execution.
- The Manager dispatches bounded specialist task packets. Specialists return
  structured results; they do not change canonical workflow state.
- State-changing commands use a Manager ownership fencing token. Provider
  session identifiers are provenance only, not authority.
- Events are append-only daily NDJSON ledgers. Active records and archive
  operations are JSON-schema validated.
- Raw provider responses are redacted and cleaned up after the configured
  retention period; resolved workflow records are archived rather than deleted.

See [contracts/README.md](contracts/README.md) for the installed operating
contracts and `agent-workflow --help` for the CLI command surface. Detailed
operator guides are available in [docs/installation.md](docs/installation.md),
[docs/upgrading.md](docs/upgrading.md), and
[docs/troubleshooting.md](docs/troubleshooting.md).

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

## Publishing

The current package name is reserved as `@agent-workflow/cli`. Before the first
registry publication, confirm that the selected npm scope is owned by the
publisher and add the public repository URL to `package.json`. The package can
already be installed from a local tarball or Git source while that decision is
pending.
