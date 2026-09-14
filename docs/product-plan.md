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

Version 0.4.1 is a local-first developer preview and CLI MVP. The following are
implemented and validated:

- Local Mission, Flight Plan, Operation, Run, Mission Report, and Clearance
  lifecycles.
- Fenced Command Authority and explicit manager handover semantics.
- Claude Code and Codex CLI Docking Adapters and shared Mission Specialist role
  definitions.
- JSON Schema validation, append-only daily Flight Recorder logs, evidence,
  reconciliation, Containment Bay, Black Box retention, and Mission Archive.
- Transactional setup, diagnostics, repair, upgrade, migration, and rollback.
- Direct local execution on the supported CLI path.

The current release does not provide Docker isolation, multi-Silo federation,
a hosted control plane, Mission Control, centralized Telemetry, multi-user
identity, RBAC, or production availability guarantees.

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

## Delivery sequence

### Stage 1: v0.5 Silo and workflow foundations

This is the immediate product priority and contains five coordinated tracks:

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

The stage is complete only when a Silo remains fully functional locally and
all new distributed metadata can be migrated without weakening governance.

### Stage 2: v0.6 Mission Modules and Airlocks

Add optional Docker-backed Runs with dedicated Git worktrees; CPU, memory,
time, process, network, filesystem, disk, and secret limits; Ingress, Egress,
and Launch Airlocks; artifact capture; cleanup; and crash recovery. Direct
local execution remains available with its lower isolation level stated
explicitly.

### Stage 3: v0.7 federated control plane

Connect authenticated Silos through Relay, add remote Module runners, transfer
artifacts with integrity verification, and replicate local events to a central
Flight Recorder. The reference deployment uses a stateless API, PostgreSQL for
platform metadata, Redis for transport and transient coordination, and object
storage for artifacts and retained captures. Each dependency remains behind a
replaceable interface.

### Stage 4: v0.8 Mission Control and Telemetry

Deliver the human interface for Keep, Colony, Silo, Mission, Crew, Charter,
Clearance, Airlock, Run, and health management. Add live status, Flight Recorder
drill-down, cost and token analysis, provider and model comparisons, reliability
metrics, and alerts. The UI receives no privileged path around Orbitkeep Core.

### Stage 5: v1.0 production control plane

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
- **Experience:** CLI ergonomics, Mission Control, accessibility, alerts,
  documentation, onboarding, and repair guidance.
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

Orbitkeep remains a developer preview at v0.4.1. A release number alone does
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

The next implementation specification should cover v0.5 only. Mission Control,
Redis deployment, remote runners, and Docker Module execution may be prototyped
against the contracts, but they are not v0.5 production deliverables. This
prevents later interfaces from dictating unfinished Core semantics.
