# Orbitkeep roadmap

This roadmap extends the validated local governance runtime into a distributed
Orbitkeep platform. Release boundaries are capability gates, not dates. A phase
is complete only when its behavior, failure modes, recovery, and evidence are
validated on supported platforms.

Orbitkeep v0.4.2 is a local-first developer preview and CLI MVP. The framework
must not be represented as a distributed, isolated, multi-user platform until
the applicable later release gates are satisfied. The detailed product and
delivery model is maintained in [product-plan.md](product-plan.md).

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

## v0.4.2 — First-install UX

Scope:

- Present concise summaries in interactive terminals.
- Preserve stable structured results behind explicit `--json` output.
- Provide `--verbose` and `--quiet` output modes.
- Make agent managers and provider hooks request JSON explicitly.
- Detect Windows Node or npm accidentally launched from WSL and return an
  actionable `WSL_WINDOWS_NODE_MISMATCH` error.
- Preserve piped-output behavior and the legacy inline `--json '{...}'` input.

Exit criteria:

- Interactive setup does not emit the complete installation object by default.
- Agent, hook, piped, and package smoke paths continue to receive valid JSON.
- Output modes are mutually exclusive and failures remain visible in quiet mode.
- Windows, native Linux, and WSL runtime-selection tests pass.
- v0.4.1 installations upgrade transactionally without rewriting canonical
  workflow history.

## v0.5 — Silo and workflow foundations

Scope:

- Add durable Silo identity and optional Keep and Colony membership metadata.
- Define Silo registration, capability, health, key-rotation, disconnection,
  degradation, blocking, and retirement states.
- Add `silo status`, `silo register`, and `silo disconnect` operations without
  making registration a prerequisite for local use.
- Implement Operation dependency graphs, deterministic eligibility scheduling,
  parallel and sequential execution, required and optional quality gates,
  cancellation propagation, and conditional routing based on validated
  outcomes.
- Add Mission and Run token, cost, time, and concurrency budgets. Keep
  retry policy distinct from result rework.
- Add reusable, versioned workflow templates.
- Emit provider-neutral usage observations suitable for later Telemetry.
- Define Relay envelopes, ordering, idempotency, authentication, and replay
  boundaries, then implement an in-memory reference transport without
  requiring a central service for local operation.
- Implement a Charter policy engine covering providers, models, resources,
  filesystem, network, secrets, Crew, gates, Clearances, consequential actions,
  retention, and redaction.
- Define central Charter versus Local Charter precedence, signature, rotation,
  and failure rules.
- Establish the public SDK/API boundary used by the CLI and future platform
  clients.
- Qualify Windows, macOS, and Linux across clean, partial, malformed,
  customized, legacy, single-provider, and dual-provider installations.

Exit criteria:

- A Silo remains fully usable in local-only mode.
- Silo identity survives repair and upgrade and cannot be silently regenerated.
- Identity and membership additions have explicit migrations and cannot weaken
  existing governance.
- The scheduler produces deterministic eligible Operations and enforces
  dependencies, gates, budgets, cancellation, retry, and rework rules without
  depending on manager prose.
- Effective policy is the intersection of central limits and local
  restrictions; local policy cannot silently expand authority.
- Relay and Charter contracts have adversarial and offline-behavior tests.
- No central component is treated as authoritative for local state it has not
  durably acknowledged.
- The supported-platform qualification suite passes.

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
- Introduce a stateless control API, durable platform metadata storage, and
  integrity-verified artifact storage behind replaceable interfaces. PostgreSQL,
  Redis, and object storage are the initial reference deployment choices;
  Redis remains transport rather than canonical workflow state.

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
- Add secrets-provider and artifact-store abstractions, workload identity,
  cryptographic key rotation, release signing, software bills of materials,
  and build provenance.
- Publish service-level objectives, capacity limits, release channels,
  deprecation guarantees, operator runbooks, and an open-source contribution
  and governance policy.

Exit criteria:

- Upgrade and rollback paths are validated from every supported release.
- Threat modeling, security review, reliability testing, and operator UAT pass.
- Local-only and centrally managed deployments have explicit support contracts.
- Backup restoration, regional or host failure recovery, workload isolation,
  and key compromise procedures pass operator exercises.
- Load, chaos, privacy, threat-model, and independent security reviews pass.

## Release qualification matrix

Every applicable release is tested across:

- Windows, macOS, and Linux.
- Clean, partial, malformed, customized, and legacy installations.
- Claude-only, Codex-only, and dual-provider configurations.
- Provider interruption, unavailable-provider, and prohibited-substitution
  behavior.
- Concurrent Missions, competing Flight Directors, expired leases, and
  fencing-token rejection.
- Upgrade and rollback from every supported release.
- Duplicate, delayed, reordered, expired, and lost Relay messages once Relay is
  implemented.
- Redaction, secret exposure, write-scope, Airlock, and container-boundary
  adversarial tests as those capabilities become available.

## Cross-cutting product workstreams

The following are release requirements, not deferred documentation exercises:

- Public SDK and API stability separate from CLI presentation.
- Extension contracts for providers, Relay transports, Airlocks, Telemetry,
  Module runtimes, secrets providers, and artifact stores.
- Authentication, workload identity, signatures, and cryptographic key
  lifecycle management.
- Platform database migrations, backups, restoration, and disaster recovery.
- Security threat modeling, dependency policy, release signing, SBOMs, and
  provenance.
- Measurable performance, scale, availability, and recovery targets.
- Explicit privacy and consent policy for product Telemetry.
- Open-source licensing, contribution, governance, compatibility, release, and
  support policies.

## Cross-cutting rules

- Mission Control is a client of Orbitkeep Core, not a privileged bypass.
- Relay transports messages; it does not become canonical workflow state.
- Flight Recorder stores authoritative history; Telemetry is derived analysis.
- A Silo owns local execution truth and never claims an unobserved outcome.
- Central Charter may bound local policy; local policy may narrow but not
  silently expand those bounds.
- Airlocks fail closed for consequential actions and record every decision.
- Product terminology must not obscure canonical API or migration behavior.
