# Installation

## Requirements

- Node.js 24.x and npm.
- A writable project repository.
- Claude Code, Codex CLI, or both when their integrations are enabled.

## Standard setup

From the project that will use Orbitkeep:

```sh
npm install --save-dev orbitkeep
npx orbitkeep setup
```

Interactive setup prints a concise summary. Use `--verbose` to see detailed
human-readable findings, `--quiet` to suppress a successful result, or `--json`
for the complete machine-readable response. Agent managers, hooks, CI, and
scripts should always use `--json` explicitly.

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
npx orbitkeep repair --plan
npx orbitkeep repair --apply
npx orbitkeep doctor
```

Malformed user-owned JSON is never overwritten. Correct it manually and rerun
the plan. Framework markers let repair update only framework-owned blocks in
shared files.

## Alternate package sources

The same setup command works after installing from a Git URL or local tarball:

```sh
npm install --save-dev /path/to/orbitkeep-0.4.2.tgz
npx orbitkeep setup
```

Pin a released version in production repositories so every Flight Director uses the
same runtime and contracts.

## Ubuntu on WSL

Install and invoke Orbitkeep with Linux Node, npm, and npx. If WSL resolves a
Windows `npx.cmd`, Windows cannot use the WSL UNC working directory and may run
Orbitkeep from `C:\Windows` instead.

```sh
hash -r
export PATH="/snap/bin:$PATH"
type -a node npm npx
node -p '"platform=" + process.platform + " executable=" + process.execPath'
```

The platform must report `linux`. A detected Windows runtime launched from WSL
fails with `WSL_WINDOWS_NODE_MISMATCH` before setup changes any files.
