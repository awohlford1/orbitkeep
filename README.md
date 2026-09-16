# Orbitkeep

**Keep every agent on mission.**

`orbitkeep` is a provider-neutral control plane for governed agent work. Claude
Code and Codex supply the intelligence; Orbitkeep supplies the operating
boundary in which that intelligence may act. A Flight Director retains model
autonomy to interpret an approved Flight Plan, dynamically select Mission
Specialists, supervise their work, own the merge lane, and escalate to the
Executive. Orbitkeep mediates those actions through identity, policy,
permissions, Clearances, lifecycle rules, evidence, recovery controls, and an
auditable Flight Recorder stored in the consuming project.

Orbitkeep does not replace the provider model or prescribe every implementation
step in advance. It constrains where and how autonomous work may occur. The
v0.5 local control envelope is not an OS security sandbox; Docker-backed
process, filesystem, network, and resource isolation is planned for v0.7.

It is intentionally independent of application code. Install it into each
repository that needs managed agent work; its runtime records stay in that
repository's ignored `.agent-state/` directory.

## Product status

Orbitkeep v0.5.0 is the active development line for the local-first developer
preview. Its local Mission governance, Claude and Codex dispatch, Flight Plans, Clearances,
Command Authority, Flight Recorder, installation repair, upgrades, retention,
archival, deterministic Operation dependencies, phase-specific quality gates,
configured concurrency enforcement, cancellation propagation, Mission and Run
resource budgets, provider-neutral usage observations, explicit bounded Run
retry policy, typed conditional routing, reusable workflows, Charter evaluation,
Relay contracts, and the public SDK boundary are implemented and validated.
The persistent Flight Director loop, dynamically governed Crew dispatch, result
return and rework, merge-lane coordination, and canonical live Crew roster are
v0.5 release blockers and are not yet complete.
Multi-Silo federation, durable network Relay transport, container isolation, a
hosted control plane, Mission Control, Telemetry, and multi-user identity are
planned capabilities and are not part of the current release.

The local Silo remains a supported deployment mode as the platform grows. A
future Keep coordinates Silos without replacing their authoritative local
execution history or allowing central services to infer unobserved outcomes.

## Install

The package requires Node.js 24.x.

```sh
npm install --save-dev orbitkeep
npx orbitkeep setup
```

Interactive terminals receive a concise human summary. Automation, agent
managers, and hooks should request the complete stable JSON response explicitly:

```sh
npx orbitkeep setup --json
```

Use `--verbose` for a detailed human report or `--quiet` to suppress successful
output. When input or output is piped, Orbitkeep defaults to JSON for backwards
compatibility. The legacy `--json '{...}'` inline-input form remains supported.

`setup` performs transactional initialization and immediately runs the health
check. A `ready` result means the required files and configured provider
integrations are active. It is a local installation guarantee; run the
provider-specific doctor to verify executable availability and authentication
for the provider you intend to use. Existing users may continue to run `init`
and `doctor` separately.

Setup also creates a durable logical Silo identity in the tracked
`.agent-workflow/silo.json` descriptor and a machine-local instance identity in
ignored runtime state. Repeated setup, repair, and upgrade preserve both IDs.
Inspect them without exposing local paths or secrets:

```sh
npx orbitkeep silo status
```

When a repository fork must become an independent Silo, close its Missions and
revoke any registration before explicitly deriving a new identity:

```sh
npx orbitkeep silo derive
```

Derivation is transactional, records its source Silo as lineage, creates a new
local instance, and never runs merely because a Git remote changed.

Keep registration is SDK-only in v0.5. The package exports the signed,
transport-neutral registration service and an in-memory contract-test adapter,
but the CLI does not simulate a durable Keep. A future authenticated Keep
adapter will activate the public registration command. Projects using the SDK
persist trusted Keep authority public keys under
`silo.registration.trustedAuthorityKeys`; private material is never stored in
project configuration.

Successful initialization reports an overall activation state and a separate
status for each configured provider. A requested provider mode is never
silently downgraded: unsupported or incomplete required integration blocks that
provider and is reported as `blocked` or `repair_required`.

Start a Mission from Orbitkeep. Orbitkeep runs the selected provider headlessly,
presents the generated Flight Plan, and keeps Executive approval in the parent
control channel. After approval, execution transfers to an authenticated local
supervisor. Interactive terminals follow the normalized live event stream by
default. Press `Ctrl+C` to detach the viewer without stopping the Mission, or
use `--detach` to return immediately; the Mission continues if the terminal
closes:

```sh
npx orbitkeep mission start --provider claude
# or
npx orbitkeep mission start --provider codex
# start without following live activity
npx orbitkeep mission start --provider codex --detach
```

Orbitkeep uses a discovery-only provider process to generate the Flight Plan.
That process cannot mutate workflow state or approve its own plan. Execution is
started in a separately brokered process only after Command Authority is active.
Bare provider sessions are not Orbitkeep Missions.

Managed Claude processes load an Orbitkeep-owned settings file and exclude the
repository and user settings sources. This prevents pre-existing project hooks
from blocking or replacing Mission responses. Orbitkeep preserves those hooks
for ordinary Claude sessions and reports the affected lifecycle events in
`doctor`; it never silently deletes project-owned configuration.

Continue managing the Mission from the Orbitkeep terminal rather than entering
the provider interface:

```sh
npx orbitkeep mission status --provider codex
npx orbitkeep mission logs --provider codex
npx orbitkeep mission watch --provider codex
npx orbitkeep mission accept --provider codex
npx orbitkeep mission ask --provider codex --question "Why is this approach preferred?"
npx orbitkeep mission steer --provider codex --instruction "Limit the change to the API package"
npx orbitkeep mission pause --provider codex --mode graceful
npx orbitkeep mission resume --provider codex
npx orbitkeep mission stop --provider codex --force
npx orbitkeep mission handover --provider codex --to claude --mode graceful
```

Verify a provider before starting work. The diagnostic checks the installed
integration, CLI availability, local authentication status, headless JSON
transport, normalized event support, and the available permission-control
level without returning account identifiers or credentials:

```sh
npx orbitkeep provider doctor --provider claude
npx orbitkeep provider doctor --provider codex
```

Orbitkeep resolves the applicable Mission, stable Flight Director identity, and
ownership lease internally. When multiple Missions require a choice, structured
automation may supply the advanced `missionId`; ordinary users select by
objective and lifecycle. `mission watch` follows live normalized activity and
reconnects after detachment, `mission status` reports durable background-job
state, and `mission logs` replays the redacted normalized provider activity
retained in `.agent-state`. A successful provider Run submits a Mission Report
but does not approve its own work; review the report and use `mission accept` to accept it,
close its Operations, and close the Mission. Pause, stop, and handover report an incomplete outcome rather
than claiming success when the provider process cannot be confirmed stopped.

For an incomplete or drifted installation, inspect the read-only repair plan
before applying it:

```sh
npx orbitkeep repair --plan
npx orbitkeep repair --apply
```

Install and repair operations are transactional. Before changing a file, the
runtime writes a journal and snapshot under the ignored
`.agent-state/installation-transactions/` directory. A failed validation rolls
the complete operation back. Malformed user-owned JSON is reported for manual
correction and is never overwritten automatically.

Inspect or recover installation transactions with:

```sh
npx orbitkeep install --status
npx orbitkeep install --recover
npx orbitkeep install --rollback
```

Rollback refuses to overwrite a file that changed after the transaction
committed. Completed transaction snapshots become cleanup-eligible after
`retention.installationBackupsDays` (30 days by default).

## Upgrade and migration

Upgrade only with the target package version already installed. Review the
versioned plan, then explicitly authorize any mutable-state migration:

```sh
npx orbitkeep upgrade --plan
npx orbitkeep upgrade --apply
npx orbitkeep upgrade --status
npx orbitkeep upgrade --rollback
```

`upgrade --apply` is the explicit authorization to apply the displayed plan,
including its registered mutable-state migrations. It does not require a
second approval flag. Library callers must still pass
`authorizeStateMigration: true` to the programmatic API.

The plan classifies files as `create`, `replace-managed`, `reconcile-shared`,
`migrate-config`, `migrate-state`, `preserve`, `manual-conflict`, or `retire`.
Only explicit one-way migrations registered by the target release may run;
v0.5.0 registers the chain from 0.3.0 through 0.4.2, including metadata-only
state migrations for branding, CLI UX, and brokered-session compatibility.
Canonical workflow records and event history are not renamed. Other source versions stop for a manual
migration decision rather than applying an inferred transformation.
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
npm install --save-dev /absolute/path/to/orbitkeep-0.5.0.tgz
npx orbitkeep init
```

`init` creates `.agent-workflow/` configuration and immutable contract copies,
provider integration templates, and the ignored runtime-state layout. Review
the generated project configuration before enabling a provider.

## Operational model

- One installed repository is a **Silo**. It remains an autonomous local
  governance boundary even when it later connects to Mission Control.
- A **Flight Director** starts or resumes a **Mission**, records a **Flight
  Plan**, and obtains or explicitly waives the configured Executive
  **Clearance** before execution.
- The Flight Director dispatches bounded **Mission Briefs** to **Mission
  Specialists**. Specialists return structured **Mission Reports**; they do
  not change canonical workflow state.
- A versioned workflow template may atomically expand portable Operation keys
  into ordinary Operations and conditional routes. Orbitkeep records the exact
  template snapshot, digest, bindings, and generated IDs so restart and audit
  do not depend on a mutable source file. The package includes
  [`software-delivery.json`](templates/software-delivery.json) as an example.
- Mission state-changing commands require fenced **Command Authority**.
  Provider session identifiers are provenance only, not authority.
- The **Flight Recorder** uses append-only daily NDJSON event ledgers. Active
  records and archive operations are JSON-schema validated.
- The **Black Box** holds short-retention redacted provider responses;
  **Containment Bay** records preserve rejected submissions and validation
  failures; resolved workflow records enter the **Mission Archive**.
- The `orbitkeep/relay` SDK defines signed, ordered, idempotent message
  envelopes and bounded replay. Its in-memory transport is a contract reference,
  not durable infrastructure and not a substitute for canonical Mission state.
- The `orbitkeep/policy` SDK evaluates Local and signed central **Charters** as
  an intersection: either may restrict an action and neither can widen the
  other. Managed Run dispatch enforces the resulting provider, model, Crew,
  resource, gate, retention, and redaction decision before creating a Run.

The product vocabulary maps to stable canonical v0.x record names. For
example, Mission maps to `assignment`, Operation to `task`, and Run to
`execution`. See [docs/domain-model.md](docs/domain-model.md) for the complete
hierarchy and compatibility map.

See [contracts/README.md](contracts/README.md) for the installed operating
contracts and `orbitkeep --help` for the CLI command surface. Detailed
operator guides are available in [docs/installation.md](docs/installation.md),
[docs/upgrading.md](docs/upgrading.md), and
[docs/troubleshooting.md](docs/troubleshooting.md). The extended platform plan
is maintained in [docs/roadmap.md](docs/roadmap.md). SDK consumers should use
only the boundary documented in [docs/sdk.md](docs/sdk.md). Release candidates
follow [docs/release.md](docs/release.md) and publish only after the evidence in
[docs/release-qualification.md](docs/release-qualification.md) is complete.

## Development

```sh
npm ci
npm run lint
npm test
npm run build
npm pack --dry-run
npm run test:package
```

`npm run verify` is the complete development and CI gate. Contributors should
also read [CONTRIBUTING.md](CONTRIBUTING.md); security reports follow
[SECURITY.md](SECURITY.md), and support expectations are in
[SUPPORT.md](SUPPORT.md).

The package includes templates for both Claude Code and Codex CLI. Capability
and provider-session behavior is detected at runtime; the runtime never claims
to control a provider action without observable confirmation.

Reusable workflow definitions are validated with
[`workflow-template.schema.json`](schemas/1.0/workflow-template.schema.json)
or `validateWorkflowTemplate` from the `orbitkeep/workflows` SDK export. Apply
them through the managed `template-apply` command. Project-specific path scope
is supplied through `bindings.affectedPaths`; roles, dependencies, gates,
budgets, retry policy, priority, and routes remain controlled by the versioned
template.

## Jira workflow diagnostics (preview)

Jira integration is optional and disabled by default. The current preview is
read-only: it can inspect an issue's current status and the direct transitions
Jira says are legal, then compare those facts with Orbitkeep's semantic
workflow profile. It never changes an issue, adds a comment, logs time, or
updates an estimate.

Configure a project-level `integrations.jira` block with a HTTPS `siteUrl`,
one or more project keys, and workflow profiles that map lifecycle intents
(such as `work_started`) to your own status names. Store an HTTP authorization
value outside the config file and reference it through an environment variable:

```json
{
  "integrations": {
    "jira": {
      "enabled": true,
      "mode": "observe",
      "siteUrl": "https://your-company.atlassian.net",
      "credentialReference": "env:ORBITKEEP_JIRA_AUTHORIZATION",
      "projectKeys": ["PAY"],
      "workflowProfiles": []
    }
  }
}
```

For guided durable setup, run `orbitkeep jira configure`. It requests the site,
project key, account email, and a hidden API-token entry; stores the resulting
authorization in Windows Credential Manager or Linux Secret Service; verifies
it with Jira's read-only identity endpoint; and writes only an
`os-keychain:` reference to project configuration. It does not accept an API
token through arguments, JSON input, or a repository file. macOS secure-store
support is not available in this preview, so it fails closed there rather than
falling back to a file.

Alternatively, set `ORBITKEEP_JIRA_AUTHORIZATION` in the invoking shell or a
supported secret manager, then run `orbitkeep jira doctor` for local
configuration health, or `orbitkeep jira doctor --issue PAY-123` to perform
the read-only workflow inspection. The diagnostic output never includes the
credential value.

To configure a custom workflow, select a representative issue in the desired
state and run `orbitkeep jira workflow-setup --issue PAY-123`. The guided flow
reads only the issue's current direct transitions and records one semantic
intent mapping at a time. A mapping is deliberately not inferred from a Jira
status name alone. After reviewing mappings with `jira doctor`, explicitly run
`orbitkeep jira enable-writes` and type its confirmation phrase to change the
integration to `automatic` mode. Even then, Orbitkeep writes only when the
issue belongs to the configured project allowlist, the configured target is a
currently legal direct transition, all required fields are present, and Jira
returns the expected target status. It never guesses multi-step paths or
automatically retries an unconfirmed write.

Managers invoke a governed update through `orbitkeep jira sync` using JSON on
standard input. The input contains the existing assignment/task identifiers,
current ownership token, Jira issue key, and semantic intent. Orbitkeep creates
an Action before contacting Jira, records it as `started`, and records a
concrete outcome afterward. A network failure or an unconfirmed transition is
recorded as `unknown`, which creates a pending reconciliation record rather
than retrying blindly. This bridge is ready for a future Relay/Scrum-agent
subscriber; in this release the manager explicitly invokes it when a Mission
event should update Jira.

A manager can bind a task at creation by including `jiraIssueKey` in its
managed `task-create` input, or bind an existing task with `orbitkeep jira
bind`. The binding is stored as a canonical `work-item` record under the
assignment. Once bound, task transitions to `running`, `blocked`, or
`cancelled`, plus accepted results and rework requests, automatically invoke
the same governed synchronization path. A Jira synchronization failure never
rolls back the completed task-state change; its separate canonical Action
records the failure or unknown outcome for review and reconciliation.

## Roadmap

- **v0.4.1 — Orbitkeep identity:** product terminology, Crew display names,
  stable compatibility aliases, and release verification.
- **v0.4.2 — First-install UX:** terminal-aware human summaries, explicit
  machine-readable output, automation-safe integrations, and actionable WSL
  runtime mismatch diagnostics.
- **v0.5 — Silo, workflow, and headless execution foundations:** headless
  Claude and Codex Mission execution, an Orbitkeep-owned streaming CLI,
  provider-inaccessible Executive approvals, retirement of provider session
  launch, a user-focused `mission` command surface, detached execution under
  an authenticated per-Silo supervisor, an attached live event stream by
  default with safe detach and `mission watch` reconnection, retained redacted
  logs, deterministic release
  artifacts, durable Silo identity and health,
  deterministic dependency scheduling, quality gates, budgets, reusable
  workflows, Charter evaluation, Relay contracts and an in-memory reference
  transport, provider-neutral usage observations, and cross-platform
  qualification.
- **v0.6 — Terminal Mission Control TUI and supervisor hardening:** a full-screen
  multi-Mission interface, bounded replay, daemon crash and reboot recovery,
  optional OS login startup, richer
  Airlocks, Crew and Mission filtering, artifact inspection, and advanced
  local Telemetry.
- **v0.7 — Mission Modules and Airlocks:** optional Docker isolation,
  per-Run worktrees, resource and secret controls, ingress/egress validation,
  consequential-action gates, result capture, cleanup, and recovery.
- **v0.8 — Relay and federation:** authenticated multi-Silo communication,
  bounded disconnected operation, remote runners, and central Flight Recorder
  replication.
- **v0.9 — Graphical Mission Control and Telemetry:** a graphical interface
  over the same Core as the CLI, with live Crew and command activity,
  Clearances, Flight Plans, Mission Reports, analytics, alerts, and audit
  drill-down.
- **v1.0 — Production control plane:** stable APIs, multi-user identity,
  organization governance, signed Charter distribution, supported deployment,
  recovery, and extension contracts.

See [docs/roadmap.md](docs/roadmap.md) for scope, exit criteria, and
cross-cutting architectural rules. See
[docs/product-plan.md](docs/product-plan.md) for the product maturity model,
delivery workstreams, sequencing, risks, and unresolved platform decisions.

The local CLI remains usable without Docker. Container isolation becomes the
recommended backend when agents run concurrently, operate unattended, or need
broad tool and shell permissions.

## Compatibility

Orbitkeep retains the legacy `agent-workflow` executable alias and the existing
`.agent-workflow/` and `.agent-state/` directories in v0.5.0. Persisted schema
identifiers, record formats, and runtime actor identifiers also remain stable.
New documentation and installations use the `orbitkeep` command. The alias is
provided to make upgrades non-breaking and may be removed only in a future
major release with an explicit migration path.
