# Troubleshooting

Start with the health report:

```sh
npx agent-workflow doctor
```

## Installation needs repair

```sh
npx agent-workflow repair --plan
npx agent-workflow repair --apply
npx agent-workflow doctor
```

Review every `manual` action. Agent Workflow will not overwrite malformed or
unrecognized user configuration.

## Interrupted transaction

```sh
npx agent-workflow install --status
npx agent-workflow install --recover
npx agent-workflow doctor
```

Recovery rolls back incomplete install, repair, or upgrade transactions to
their captured pre-operation state.

## Upgrade is blocked

Common causes are active assignments, an unsupported version path, a requested
downgrade, or user changes in a retired managed file. `upgrade --plan` reports
the exact blocker. Close active work or resolve the named file, then regenerate
the plan.

## Rollback conflict

A rollback stops rather than overwrite a file changed after the transaction.
Preserve the current file, compare it with the snapshot under
`.agent-state/installation-transactions/`, and reconcile it manually.

## Provider is not active

Read the provider-specific status and reason in `doctor`. Confirm the provider
CLI is installed, the repository hook or manager reference is complete, and
the configured enforcement mode is supported. Then use `repair --plan`; the
runtime never reports unsupported enforcement as active.
