# Orbitkeep product plan

This plan defines how Orbitkeep grows from a validated local CLI framework into
a fully operational distributed platform. The versioned capability gates are
authoritative in [roadmap.md](roadmap.md); this document explains product
maturity, delivery sequencing, architectural workstreams, risks, and decisions.

## Product objective

Orbitkeep provides a provider-neutral control plane for governed agent work.
It should let an individual, team, or organization coordinate AI agents across
repositories while preserving explicit authority, isolation, evidence,
recoverability, and human control over consequential actions.

## Current baseline

Version 0.5.0 is the active development line for the local-first developer
preview. The following code baseline capabilities are implemented and
validated:

- Local Mission, Flight Plan, Operation, Run, Mission Report, and Clearance
  lifecycles.
- Fenced Command Authority and explicit manager handover semantics.
- Claude Code and Codex CLI Docking Adapters and shared Mission Specialist role
  definitions.
- JSON Schema validation, append-only daily Flight Recorder logs, evidence,
  reconciliation, Containment Bay, Black Box retention, and Mission Archive.
- Transactional setup, diagnostics, repair, upgrade, migration, and rollback.
- Direct local execution on the supported CLI path.
- Terminal-aware human summaries with explicit JSON output for agents and
  automation, plus WSL runtime-mismatch guidance.
- Brokered interactive Claude and Codex launch with stable manager identity,
  secret-bound session context, and approval-aware Claude tool authorization.
- Release preflight and explicit package contents that prevent dirty-tree
  publication and internal design-document leakage.

Live UAT found the interactive provider launcher unsuitable as Orbitkeep's
published Mission experience: it exposes provider-specific UX, allows the
provider environment to influence approval handling, and cannot provide the
required provider-neutral control boundary. Before v0.5 may publish, it must
add headless Claude and Codex execution, an Orbitkeep-owned streaming CLI, and
a provider-inaccessible Executive Clearance channel.

The current release also does not provide Docker isolation, multi-Silo
federation, a hosted control plane, full terminal Mission Control, graphical
Mission Control, centralized Telemetry, multi-user identity, RBAC, or
production availability guarantees.

## Product principles

1. Local-first operation remains supported. Central services coordinate Silos
   but do not replace local execution truth.
2. Orbitkeep Core is the only supported workflow mutation path. The CLI,
   Mission Control, and integrations are clients of the same rules.
3. Consequential actions fail closed at Airlocks and always produce evidence.
4. Relay transports messages; it is never canonical workflow state.
5. The Flight Recorder is authoritative history; Telemetry is derived analysis.
6. Central Charter bounds may be narrowed locally but cannot be expanded
   silently.
7. Product vocabulary does not obscure stable APIs, schemas, or migrations.
8. A capability is not advertised as operational until its failure, recovery,
   security, and cross-platform behavior is tested.
9. Orbitkeep owns the supported Mission experience. Provider interfaces are
   replaceable execution surfaces, and provider output is never an Executive
   authorization channel.

## Delivery sequence

### Stage 1: v0.5 Silo, workflow, and headless execution foundations

This is the immediate product priority and contains seven coordinated tracks:

1. **Silo identity and lifecycle:** durable identity, optional Keep and Colony
   membership, registration, capabilities, health, disconnection, degradation,
   blocking, retirement, and key rotation.
2. **Workflow engine:** dependency graphs, deterministic scheduling, parallel
   and sequential Operations, quality gates, budgets, templates, cancellation,
   retries, rework, and conditional routing.
3. **Charter engine:** central and local precedence, signed policy, provider and
   model restrictions, permissions, resource controls, approvals, retention,
   and redaction.
4. **Relay protocol:** authenticated envelopes, ordering, idempotency,
   acknowledgement, retry, expiration, offline behavior, replay limits, and an
   in-memory reference transport.
5. **Qualification:** Windows, macOS, and Linux coverage across installation,
   provider, concurrency, recovery, upgrade, and adversarial scenarios.
6. **Headless provider execution:** Claude and Codex run as managed child
   processes, emit normalized live activity, and never become the user-facing
   Mission interface or an Executive authorization channel.
7. **Public CLI cleanup:** human-facing `mission` commands and stable `--json`
   automation are separated from provider diagnostics and internal Core
   mutation operations. `session launch --provider ...` is retired through a
   non-launching compatibility tombstone and removed from normal help.
8. **Detached execution foundation:** approved provider work transfers to an
   authenticated per-Silo local supervisor. The launching terminal may exit;
   durable job status and seven-day retained, redacted activity remain
   available through `mission status` and `mission logs`.

The stage is complete only when a Silo remains fully functional locally and
all new distributed metadata can be migrated without weakening governance. A
basic Mission must also complete through both headless providers with
Orbitkeep-owned planning, approval, detached execution, reconnectable activity,
result handling, and cleanup.

### Stage 2: v0.6 full CLI Mission Control and local supervisor

Expand the v0.5 local-supervisor foundation into a full terminal Mission
Control with attach/watch sessions, multiple concurrent Missions, bounded
replay, daemon crash reconciliation, optional OS login startup, richer
Airlock decisions, Crew and Mission filtering, Flight Recorder exploration,
result and artifact inspection, and advanced local Telemetry. Complete removal
of the temporary `session launch` compatibility tombstone in this stage.

### Stage 3: v0.7 Mission Modules and Airlocks

Add optional Docker-backed Runs with dedicated Git worktrees; CPU, memory,
time, process, network, filesystem, disk, and secret limits; Ingress, Egress,
and Launch Airlocks; artifact capture; cleanup; and crash recovery. Direct
local execution remains available with its lower isolation level stated
explicitly.

### Stage 4: v0.8 federated control plane

Connect authenticated Silos through Relay, add remote Module runners, transfer
artifacts with integrity verification, and replicate local events to a central
Flight Recorder. The reference deployment uses a stateless API, PostgreSQL for
platform metadata, Redis for transport and transient coordination, and object
storage for artifacts and retained captures. Each dependency remains behind a
replaceable interface.

### Stage 5: v0.9 graphical Mission Control and Telemetry

Deliver the graphical human interface for Keep, Colony, Silo, Mission, Crew,
Charter, Clearance, Airlock, Run, and health management. Add live Crew and
command activity, Flight Plan and Mission Report views, Flight Recorder
drill-down, cost and token analysis, provider and model comparisons,
reliability metrics, and alerts. The graphical UI and CLI use the same Core
APIs, transitions, and authorization boundaries; neither receives a privileged
path around Orbitkeep Core.

### Stage 6: v1.0 production control plane

Stabilize APIs and schemas; add multi-user identity, RBAC, SSO readiness,
workload identity, signed Charter distribution, supported deployment profiles,
backup and disaster recovery, monitoring, security hardening, extension APIs,
release provenance, formal compatibility guarantees, and operator support
boundaries.

## Platform workstreams

- **Core and SDK:** extract a stable programmatic API from CLI presentation.
- **Workflow orchestration:** deterministic scheduling, arbitration, budgets,
  gates, retries, rework, cancellation, and recovery.
- **Security and identity:** users, workloads, signatures, keys, secrets,
  Airlocks, isolation, and threat modeling.
- **Distributed systems:** Relay, offline operation, reconciliation, remote
  runners, event replication, and artifact integrity.
- **Data and operations:** metadata persistence, archives, backups, restoration,
  migrations, retention, and disaster recovery.
- **Experience:** interactive CLI Mission Control, graphical Mission Control,
  normalized live provider activity, accessible approvals and steering,
  alerts, documentation, onboarding, and repair guidance.
- **Telemetry and evaluation:** cost, tokens, latency, throughput, rework,
  reliability, provider behavior, privacy controls, and regression benchmarks.
- **Ecosystem:** provider, transport, Airlock, Module, secret, artifact, and
  Telemetry extension contracts plus open-source governance.

## Readiness levels

| Level | Meaning |
| --- | --- |
| Developer preview | Suitable for informed local evaluation; interfaces may change through documented migrations. |
| Local production | Supported local Silo operation with defined platforms, recovery, and compatibility guarantees. |
| Federated preview | Multiple Silos can coordinate, but deployment and availability guarantees remain limited. |
| Platform production | Multi-user, isolated, observable, recoverable, security-reviewed operation with published support boundaries. |

Orbitkeep remains a developer preview at v0.5.0. A release number alone does
not advance its readiness level; the corresponding qualification evidence must
exist.

## Success measures

- Setup and repair success rates across supported repository shapes.
- Percentage of consequential actions protected by an observed Airlock result.
- Mission completion, rework, failure, cancellation, and unknown-outcome rates.
- Time to recover interrupted Runs, Silos, upgrades, and Relay connections.
- Token, cost, and elapsed-time variance by workflow, role, provider, and model.
- Duplicate or reordered message recovery without duplicated effects.
- Zero silent authority expansion, provider substitution, or fabricated
  completion in qualification testing.
- Operator time required to diagnose and recover common failures.

## Principal risks

- Building Mission Control before Core contracts stabilize could make UI
  behavior an accidental source of truth.
- Launching users inside provider interfaces makes Orbitkeep dependent on
  provider-specific prompts, permission behavior, and session UX. Headless
  adapters and an Orbitkeep-owned control channel must precede the graphical
  client.
- Treating a provider prompt or provider-supplied actor claim as Executive
  authorization would allow self-approval. Executive decisions require a
  capability unavailable to managed provider processes.
- Advertising internal state-transition commands as ordinary user commands
  exposes assignment IDs, ownership tokens, and implementation vocabulary,
  and makes unsafe or invalid workflows easier to invoke. The supported public
  CLI must express user intent and mediate those internal transitions.
- Treating Redis or another queue as canonical state could lose auditability
  during retry, replay, or failover.
- Containerization without strict ingress, egress, secret, and cleanup controls
  could create the appearance of isolation without a defensible boundary.
- Central coordination could weaken local autonomy if disconnected-operation
  rules and last-known Charter limits are ambiguous.
- Provider behavior and identifiers can drift, so observed capabilities must be
  distinguished from configured expectations.
- Premature canonical terminology renames could create incompatible schemas and
  state migrations.

## Decisions required before later stages

The following decisions are intentionally not fixed by v0.5 foundations:

- Whether the first platform distribution is self-hosted, hosted, or both.
- The identity provider and SSO integration strategy.
- Initial secrets manager and object-storage integrations.
- Supported host and container-runtime matrix.
- Availability, recovery-time, recovery-point, and scale objectives.
- Product Telemetry defaults and consent model.
- Extension compatibility and marketplace governance.
- Commercial packaging, support tiers, and hosted-service boundaries.

These decisions must be made before their dependent implementation begins, but
they should not delay provider-neutral Core, Silo, Charter, workflow, and Relay
contracts.

## Immediate implementation boundary

The next implementation specifications cover v0.5 only. The first draft is the
[Silo identity and lifecycle specification](https://github.com/awohlford1/orbitkeep/blob/main/docs/specifications/v0.5-silo-identity-lifecycle.md).
The implemented release-stabilization baseline is documented in the
[session broker and release integrity specification](https://github.com/awohlford1/orbitkeep/blob/main/docs/specifications/v0.5-session-broker-release-integrity.md).
The headless Claude and Codex adapters, minimum streaming Mission CLI,
Executive control-channel separation, `session launch` retirement, and public
CLI cleanup are v0.5 release blockers. Full terminal Mission Control remains a
v0.6 deliverable. Docker Module execution moves to v0.7, Redis deployment and
remote runners move to v0.8, and graphical Mission Control moves to v0.9. This
sequence provides a usable v0.5 without allowing later presentation layers to
dictate unfinished Core semantics.
