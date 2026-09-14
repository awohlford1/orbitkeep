# Upgrading

npm selects and installs the package version. Orbitkeep then reconciles
that version's managed files and registered state migrations inside the
consumer repository.

## Standard upgrade

Close active workflow assignments, then run:

```sh
npm install --save-dev orbitkeep@0.4.1
npx orbitkeep upgrade --plan
npx orbitkeep upgrade --apply
npx orbitkeep doctor
```

Review the plan before applying it. `upgrade --apply` is the user's explicit
authorization to run the plan, including listed mutable-state migrations. The
CLI will not infer a migration path or silently downgrade an integration.

## Failure and recovery

An interrupted or failed transaction is recoverable:

```sh
npx orbitkeep upgrade --status
npx orbitkeep install --recover
```

To reverse the most recent committed upgrade integration:

```sh
npx orbitkeep upgrade --rollback
npm install --save-dev orbitkeep@PREVIOUS_VERSION
npx orbitkeep doctor
```

Rollback restores the repository files captured by the transaction. npm still
owns the installed package version, so reinstall the previous version as a
separate step. Rollback refuses to overwrite files modified after the upgrade.

Version 0.4.1 registers an explicit chain from 0.3.0 through 0.4.0 and a
metadata-only state migration from 0.4.0 to 0.4.1. The latter advances the
installation receipt while preserving canonical workflow records and event
history. Other starting versions require a supported migration path or a
documented manual procedure.
