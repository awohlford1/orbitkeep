# Upgrading

npm selects and installs the package version. Agent Workflow then reconciles
that version's managed files and registered state migrations inside the
consumer repository.

## Standard upgrade

Close active workflow assignments, then run:

```sh
npm install --save-dev @agent-workflow/cli@0.4.0
npx agent-workflow upgrade --plan
npx agent-workflow upgrade --apply
npx agent-workflow doctor
```

Review the plan before applying it. `upgrade --apply` is the user's explicit
authorization to run the plan, including listed mutable-state migrations. The
CLI will not infer a migration path or silently downgrade an integration.

## Failure and recovery

An interrupted or failed transaction is recoverable:

```sh
npx agent-workflow upgrade --status
npx agent-workflow install --recover
```

To reverse the most recent committed upgrade integration:

```sh
npx agent-workflow upgrade --rollback
npm install --save-dev @agent-workflow/cli@PREVIOUS_VERSION
npx agent-workflow doctor
```

Rollback restores the repository files captured by the transaction. npm still
owns the installed package version, so reinstall the previous version as a
separate step. Rollback refuses to overwrite files modified after the upgrade.

Version 0.4.0 registers an explicit migration from 0.3.0. Other starting
versions require a supported migration path or a documented manual procedure.
