# Troubleshooting

## Provider integration is active but the CLI is not found

Orbitkeep can install provider hooks and instructions without installing the
provider's own CLI. Install and authenticate Claude Code or Codex CLI in the
same Ubuntu, WSL, macOS, or Windows environment where `npx orbitkeep` runs, then
rerun `npx orbitkeep doctor`. An `active` integration alone does not mean its
provider executable is available.

## Claude reports `WORKFLOW_BROKER_SESSION_REQUIRED`

The repository has enforced Claude hooks, but Claude was launched directly or
the headless broker context was lost. Exit that session and start the Mission
from the repository root:

```sh
npx orbitkeep mission start --provider claude
```

Do not copy assignment IDs, ownership tokens, or broker secrets into a provider
session manually. Orbitkeep creates the Mission, retains those values, and
binds them to its headless provider processes.

Start with the health report:

```sh
npx orbitkeep doctor
```

## A pre-existing Claude hook blocks or rewrites a Mission response

Run `npx orbitkeep doctor --json` and inspect
`hookInspection.claudeProject.additional`. Orbitkeep-managed Missions use only
`.agent-workflow/providers/claude/settings.json` and exclude project and user
settings sources, so these hooks should affect bare Claude sessions only. If
`missionIsolation.claude.enabled` is false, run `npx orbitkeep repair --plan`
and apply the repair before starting another Mission. Do not delete a
project-owned hook merely to make Orbitkeep report healthy.

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
