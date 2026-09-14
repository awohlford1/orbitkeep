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
npx agent-workflow init
npx agent-workflow doctor
```

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

Repair restores only package-managed files recorded in the installation
manifest and reconciles recognized Manager/hook integration points. Existing
files are backed up under the ignored `.agent-state/installation-backups/`
directory before replacement. Malformed user-owned JSON is reported for manual
correction and is never overwritten automatically.

For local development before publication:

```sh
npm pack
npm install --save-dev /absolute/path/to/agent-workflow-0.2.0.tgz
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
contracts and `agent-workflow --help` for the CLI command surface.

## Development

```sh
npm ci
npm run lint
npm test
npm run build
npm pack --dry-run
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
