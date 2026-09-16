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

Install and authenticate at least one supported provider CLI separately, then
start a headless Mission through Orbitkeep:

```sh
npx orbitkeep mission start --provider claude
# or
npx orbitkeep mission start --provider codex
```

Direct provider sessions are not Orbitkeep Missions and do not possess the
broker capability required by the blocking hook.

Confirm provider readiness without starting a Mission:

```sh
npx orbitkeep provider doctor --provider claude
npx orbitkeep provider doctor --provider codex
```

The provider diagnostic is read-only. It reports integration, executable,
authentication, headless-streaming, and permission-control readiness without
printing provider account details or credential material.

For Claude, Orbitkeep installs a separate managed settings file under
`.agent-workflow/providers/claude/`. Headless Missions explicitly load that file
with repository and user setting sources disabled, so existing project hooks
cannot alter the managed Mission. The original `.claude/settings.json` remains
intact except for Orbitkeep's own additive direct-session enforcement hooks.
`doctor --json` reports both hook sets and lists lifecycle events that also have
project-owned hooks.

After approval, execution runs under Orbitkeep's authenticated per-Silo local
supervisor, so it is not owned by the terminal that launched it. Closing that
terminal disconnects the user without stopping the provider. Use `orbitkeep
mission status` to reconnect to durable job state and `orbitkeep mission logs`
to replay redacted normalized activity. This release does not yet configure an
OS login service, so a machine reboot still requires explicit recovery.

After a successful Run, review the submitted Mission Report with `orbitkeep
mission logs`, then run `orbitkeep mission accept --provider claude|codex` to
accept the report and close the Mission. Providers cannot invoke this parent
control action or accept their own output.

After a Mission starts, use `orbitkeep mission status`, `mission logs`, `mission accept`, `mission ask`,
`mission steer`, `mission pause`, `mission resume`, `mission stop`, and `mission handover` from
the parent terminal. Each command takes `--provider claude|codex`; handover also
takes `--to claude|codex`. Orbitkeep keeps assignment identifiers and ownership
tokens out of the normal interaction.

Interactive setup prints a concise summary. Use `--verbose` to see detailed
human-readable findings, `--quiet` to suppress a successful result, or `--json`
for the complete machine-readable response. Agent managers, hooks, CI, and
scripts should always use `--json` explicitly.

Provider integration status and provider CLI availability are separate checks.
An integration may be correctly installed while its executable is not yet on
`PATH`; setup and doctor report that condition as `CLI not found` with a warning.

`setup` installs the repository integration transactionally and runs `doctor`.
The operation preserves unrelated configuration and user-owned files. It adds
framework-owned contracts beneath `.agent-workflow/`, provider references and
hooks, and the ignored `.agent-state/` runtime directory.

It also creates `.agent-workflow/silo.json`, the committed logical identity of
the repository Silo, and `.agent-state/.runtime/silo-instance.json`, the
ignored identity of this checkout. Both are stable across repeated setup,
repair, and upgrade. Use `npx orbitkeep silo status` to inspect the safe status
projection. Use `npx orbitkeep silo derive` only when a fork is intentionally
becoming an independent Silo; the command is blocked by open Missions or a
registration receipt and commits both identity replacements transactionally.

Registration remains an SDK integration in v0.5. `silo status` can verify and
display an SDK-created registration after its Keep authority public key is
configured in `silo.registration.trustedAuthorityKeys`. Setting
`silo.registration.required` to `true` makes a missing or invalid receipt a
blocking Local Charter condition. The default is `false`, so local-only Silos
remain fully operational. The `local_file_degraded` credential provider is for
developer preview only and is reported as degraded by diagnostics.

The result is:

- `ready`: all required local integration is active. Run `provider doctor` for
  the selected provider's executable and authentication readiness.
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

Additional Claude hooks are preserved and reported. They do not run inside an
Orbitkeep-managed headless Mission because its provider settings are isolated.

## Alternate package sources

The same setup command works after installing from a Git URL or local tarball:

```sh
npm install --save-dev /path/to/orbitkeep-0.5.0.tgz
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
