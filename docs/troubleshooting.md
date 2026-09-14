# Troubleshooting

Start with the health report:

```sh
npx orbitkeep doctor
```

## Installation needs repair

```sh
npx orbitkeep repair --plan
npx orbitkeep repair --apply
npx orbitkeep doctor
```

Review every `manual` action. Orbitkeep will not overwrite malformed or
unrecognized user configuration.

## Interrupted transaction

```sh
npx orbitkeep install --status
npx orbitkeep install --recover
npx orbitkeep doctor
```

Recovery rolls back incomplete install, repair, or upgrade transactions to
their captured pre-operation state.

## Upgrade is blocked

Common causes are active Missions (canonical assignments), an unsupported version path, a requested
downgrade, or user changes in a retired managed file. `upgrade --plan` reports
the exact blocker. Close active work or resolve the named file, then regenerate
the plan.

## Rollback conflict

A rollback stops rather than overwrite a file changed after the transaction.
Preserve the current file, compare it with the snapshot under
`.agent-state/installation-transactions/`, and reconcile it manually.

## Provider is not active

Read the provider-specific status and reason in `doctor`. Confirm the provider
CLI is installed, the repository hook or Flight Director reference is complete, and
the configured enforcement mode is supported. Then use `repair --plan`; the
runtime never reports unsupported enforcement as active.

## WSL starts CMD.EXE or uses `C:\Windows`

This means WSL resolved Windows Node or `npx.cmd` instead of the Linux runtime.
Orbitkeep reports `WSL_WINDOWS_NODE_MISMATCH` when it can observe this mixed
environment. In the Ubuntu shell, verify and correct command resolution:

```sh
hash -r
export PATH="/snap/bin:$PATH"
type -a node npm npx
node -p '"platform=" + process.platform + " executable=" + process.execPath'
```

The platform must be `linux`, and the first command paths should be Linux paths
such as `/snap/bin`. Reinstall repository dependencies with Linux npm if they
were originally created through Windows npm.
