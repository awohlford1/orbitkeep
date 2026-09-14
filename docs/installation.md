# Installation

## Requirements

- Node.js 24.x and npm.
- A writable project repository.
- Claude Code, Codex CLI, or both when their integrations are enabled.

## Standard setup

From the project that will use Agent Workflow:

```sh
npm install --save-dev @agent-workflow/cli
npx agent-workflow setup
```

`setup` installs the repository integration transactionally and runs `doctor`.
The operation preserves unrelated configuration and user-owned files. It adds
framework-owned contracts beneath `.agent-workflow/`, provider references and
hooks, and the ignored `.agent-state/` runtime directory.

The result is:

- `ready`: all required integration is active.
- `attention_required`: installation completed, but one or more health checks
  needs attention. Read `health.errors`, then run `repair --plan`.
- `failed`: no successful setup was produced. The transaction automatically
  rolls back when validation fails.

## Existing or customized repositories

Use the read-only plan before changing a partial or drifted installation:

```sh
npx agent-workflow repair --plan
npx agent-workflow repair --apply
npx agent-workflow doctor
```

Malformed user-owned JSON is never overwritten. Correct it manually and rerun
the plan. Framework markers let repair update only framework-owned blocks in
shared files.

## Alternate package sources

The same setup command works after installing from a Git URL or local tarball:

```sh
npm install --save-dev /path/to/agent-workflow-0.4.0.tgz
npx agent-workflow setup
```

Pin a released version in production repositories so every manager uses the
same runtime and contracts.
