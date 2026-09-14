# Orbitkeep roadmap

This roadmap extends the validated local governance runtime into a distributed
Orbitkeep platform. Release boundaries are capability gates, not dates. A phase
is complete only when its behavior, failure modes, recovery, and evidence are
validated on supported platforms.

## v0.4.1 — Orbitkeep identity

Scope:

- Adopt the Orbitkeep package and CLI name.
- Introduce the Keep, Colony, Silo, Mission, Flight Director, Mission
  Specialist, Flight Plan, Operation, Run, and Mission Report vocabulary.
- Add Crew Manifest display names while preserving stable role IDs.
- Reserve Mission Control, Charter, Relay, Airlock, Telemetry, Flight Recorder,
  Mission Module, Docking Adapter, Containment Bay, and Black Box as defined
  component names.
- Retain the `agent-workflow` executable alias and all canonical workflow v0.x
  names; update only installation metadata through the explicit migration.

Exit criteria:

- Existing state and integrations remain readable.
- Both CLI names resolve to the same runtime.
- Generated Claude and Codex roles use the new display vocabulary.
- Package, integration, migration, and compatibility tests pass.

## v0.5 — Silo and workflow foundations

Scope:

- Add durable Silo identity and optional Keep and Colony membership metadata.
- Define Silo registration, capability, health, and disconnection states.
- Complete task dependencies, quality gates, execution budgets, reusable
  workflow templates, and cross-platform validation.
- Emit provider-neutral usage observations suitable for later Telemetry.
- Define Relay envelopes, ordering, idempotency, authentication, and replay
  boundaries without requiring a central service for local operation.
- Define central Charter versus Local Charter precedence and signature rules.

Exit criteria:

- A Silo remains fully usable in local-only mode.
- Identity and membership additions have explicit migrations and cannot weaken
  existing governance.
- Relay and Charter contracts have adversarial and offline-behavior tests.
- No central component is treated as authoritative for local state it has not
  durably acknowledged.

## v0.6 — Mission Modules and Airlocks

Scope:

- Add an optional Docker execution adapter with per-Run worktrees.
- Enforce CPU, memory, time, process, network, filesystem, and secret limits.
- Implement Ingress and Egress Airlocks around every Module.
- Implement a Launch Airlock for merge, publish, deploy, and external-message
  actions.
- Capture results, evidence, logs, cleanup state, and crash recovery.
- Keep the local non-container CLI supported for lower-risk use cases.

Exit criteria:

- Isolation and escape-boundary tests pass on every supported host platform.
- An Airlock failure prevents the protected action and records the reason.
- Interrupted Modules are recoverable or resolve to an explicit unknown state.
- Secrets and raw responses follow configured redaction and retention policy.

## v0.7 — Relay and federated Silos

Scope:

- Implement Relay behind a transport abstraction, with Redis as the initial
  deployment option.
- Register and authenticate multiple Silos within a Keep.
- Route commands, status, Beacons, handovers, and event acknowledgements.
- Support bounded disconnected Silo operation using a last-known valid Charter.
- Add remote Module runners and artifact transfer with integrity verification.
- Replicate Silo event records to a central Flight Recorder without changing
  local event history.

Exit criteria:

- Delivery is idempotent and resilient to duplicate, delayed, and reordered
  messages.
- Relay loss cannot silently grant authority or fabricate completion.
- Reconnection reconciles explicit state rather than applying last-writer wins.
- Central and local audit records retain verifiable provenance.

## v0.8 — Mission Control and Telemetry

Scope:

- Deliver Mission Control for Keep, Colony, Silo, Mission, Crew, Clearance,
  Airlock, and health management.
- Add live Mission and Run views with Flight Recorder drill-down.
- Add Telemetry for tokens, cost, duration, throughput, rework, failures,
  provider/model performance, and Airlock outcomes.
- Provide human Go/No-Go and Course Correction workflows without allowing the
  UI to bypass Orbitkeep Core.
- Add alerting and operational dashboards for disconnected or unhealthy Silos.

Exit criteria:

- Every displayed decision and state links to its authoritative source.
- Telemetry distinguishes observed measurements from estimates.
- UI authorization is tested independently from workflow authorization.
- Accessibility, recovery, and destructive-action safeguards are validated.

## v1.0 — Production control plane

Scope:

- Stabilize public APIs, schemas, migrations, and compatibility policy.
- Add multi-user identity, role-based access, SSO-ready authentication, signed
  Charter distribution, and centrally governed Clearance policy.
- Establish supported deployment, backup, disaster-recovery, monitoring,
  upgrade, and security-hardening profiles.
- Publish a formal extension model for providers, Relay transports, Airlocks,
  Telemetry exporters, and Module runtimes.

Exit criteria:

- Upgrade and rollback paths are validated from every supported release.
- Threat modeling, security review, reliability testing, and operator UAT pass.
- Local-only and centrally managed deployments have explicit support contracts.

## Cross-cutting rules

- Mission Control is a client of Orbitkeep Core, not a privileged bypass.
- Relay transports messages; it does not become canonical workflow state.
- Flight Recorder stores authoritative history; Telemetry is derived analysis.
- A Silo owns local execution truth and never claims an unobserved outcome.
- Central Charter may bound local policy; local policy may narrow but not
  silently expand those bounds.
- Airlocks fail closed for consequential actions and record every decision.
- Product terminology must not obscure canonical API or migration behavior.
