# Orbitkeep roadmap

This roadmap extends the validated local governance runtime into a distributed
Orbitkeep platform. Release boundaries are capability gates, not dates. A phase
is complete only when its behavior, failure modes, recovery, and evidence are
validated on supported platforms.

Orbitkeep v0.5.0 is the active development line for a local-first developer preview. The framework
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

## v0.5 — Silo, workflow, and headless execution foundations

The first focused design is the
[Silo identity and lifecycle specification](https://github.com/awohlford1/orbitkeep/blob/main/docs/specifications/v0.5-silo-identity-lifecycle.md).
The release-stabilization design is the
[session broker and release integrity specification](https://github.com/awohlford1/orbitkeep/blob/main/docs/specifications/v0.5-session-broker-release-integrity.md).
The workflow-engine design is the
[v0.5 workflow engine specification](https://github.com/awohlford1/orbitkeep/blob/main/docs/specifications/v0.5-workflow-engine.md).

Stabilization work completed or begun at the start of this release:

- Brokered interactive Claude and Codex session launch with stable provider
  manager identities.
- Fail-closed Claude authorization for direct sessions and restricted,
  secret-bound bootstrap access for brokered sessions.
- Automatic binding of a brokered session to its Mission ownership lease after
  `start`, `resume`, or ownership recovery.
- Local-install command guidance consistently uses `npx orbitkeep`.
- Publish preflight rejects dirty working trees, and package contents exclude
  uncommitted specifications.

Live UAT demonstrated that launching users into provider-owned interfaces does
not provide a reliable Orbitkeep workflow or Executive authorization boundary.
Orbitkeep therefore must not publish v0.5 with interactive provider launch as
its primary Mission path. Headless provider execution and a minimal
Orbitkeep-owned streaming CLI are v0.5 release blockers.

Scope:

- Add durable Silo identity and optional Keep and Colony membership metadata.
- Define Silo registration, capability, health, key-rotation, disconnection,
  degradation, blocking, and retirement states.
- Add `silo status` and the transport-neutral registration SDK without making
  registration a prerequisite for local use. Keep the public registration and
  disconnect CLI commands reserved until a persistent authenticated Keep
  adapter exists; the in-memory adapter is for contract and UAT tests only.
- Operation dependency graphs, deterministic eligibility scheduling, parallel
  and sequential execution, required and optional quality gates, cancellation
  propagation, and conditional routing based on validated outcomes are
  implemented.
- Mission and Run token, cost, time, and concurrency budgets are implemented.
  Bounded retry policy is implemented with a new Run per retry and remains
  distinct from Mission Report rework.
- Reusable, versioned workflow templates now expand atomically into canonical
  scheduling and routing records with immutable provenance, portable aliases,
  path bindings, Crew-role enforcement, and an authoring schema.
- Provider-neutral usage observations are emitted and persisted for later
  Telemetry.
- Relay envelopes, strict per-stream ordering, retained-message idempotency,
  Ed25519 authentication, bounded replay, a public schema, and an in-memory
  reference transport are implemented without requiring a central service for
  local operation. Durable network transport remains v0.8 scope.
- The Charter SDK now covers providers, models, resources, filesystem, network,
  secrets, Crew, gates, Clearances, retention, and redaction, and is enforced at
  managed Run dispatch.
- Central and Local Charter intersection, Ed25519 trust, monotonic revision,
  key-rotation overlap, expiry, conflict, rollback, and failure rules are
  defined and tested. Durable Keep-delivered Charter storage remains future
  integration work.
- The public SDK/API boundary used by the CLI and future platform clients is
  explicit, documented, packed-consumer tested, and restricted by package
  exports.
- Add headless Claude and Codex Docking Adapters that stream structured
  provider output without placing the user inside either provider interface.
- Add the provider-neutral public Mission commands `mission start`, `mission
  resume`, `mission status`, `mission logs`, `mission accept`, `mission ask`, `mission steer`, `mission pause`,
  `mission handover`, `mission stop`, and `mission cancel`, with provider selection treated as
  configuration or an option rather than a separate workflow.
- Make Orbitkeep own Flight Plan presentation and Executive Clearance through
  a control channel unavailable to managed provider processes. Provider
  output and provider-supplied actor metadata are not authorization.
- Stream a minimum normalized activity feed covering provider messages, Crew
  dispatch, tool and command execution, results, failures, and usage while
  retaining redacted raw events only for configured diagnostic retention.
- Follow that activity automatically in interactive terminals after Mission
  launch. `Ctrl+C` detaches the viewer without stopping the Mission,
  `--detach` opts out at launch, and `mission watch` reconnects later. Scripts,
  redirected output, and `--json` remain non-blocking and detached.
- Run approved provider execution beneath an authenticated per-Silo local
  supervisor so terminal exit only disconnects the user. Persist job state and
  normalized redacted activity for later status and log replay. Automatic OS
  login startup and reboot recovery remain post-v0.5 hardening work.
- Retire `session launch --provider ...` from the public interface. Remove it
  from normal help and documentation, prevent it from launching a provider,
  and retain only a temporary `COMMAND_RETIRED` compatibility response that
  directs users to `mission start --provider ...`.
- Separate the CLI into a human Mission surface, stable `--json` automation,
  provider diagnostics, and internal Core mutation operations. Low-level
  assignment IDs, fencing tokens, ownership acquisition, raw plan-approval
  commands, and reconciliation commands are not part of the normal user UX.
- Add `provider doctor` diagnostics for Claude and Codex installation,
  authentication, headless execution, event streaming, and permission support.
- Windows, macOS, and Linux qualification runs through a required CI matrix
  across clean, partial, malformed, customized, legacy, single-provider, and
  dual-provider installation coverage. The exact release-candidate evidence
  remains pending until all three jobs pass.

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
- A user can plan, approve, execute, observe, steer, pause, resume, and finish
  a basic Mission through Orbitkeep without entering a provider interface.
- Managed provider processes cannot grant their own Executive Clearance or
  reach an equivalent approval capability through the public CLI.
- Claude and Codex pass the same basic headless Mission UAT, including event
  capture, automatic result submission, explicit parent-channel acceptance,
  failure, and cleanup. A provider cannot accept its own Mission Report.
- Retired commands fail clearly and safely, and public help does not advertise
  provider sessions or internal workflow mutation commands as user workflows.
- No central component is treated as authoritative for local state it has not
  durably acknowledged.
- The supported-platform qualification suite passes.

Release evidence is tracked in
[release-qualification.md](release-qualification.md); configured automation is
not treated as a passing platform result before it runs on the candidate SHA.

## v0.6 — Terminal Mission Control TUI and supervisor hardening

Scope:

- Expand the v0.5 streaming Mission CLI into a full-screen interactive terminal
  Mission Control TUI with live Crew activity,
  tool and command execution, file changes, Run state, Airlock requests,
  Mission Reports, and estimated usage Telemetry.
- Harden the v0.5 local supervisor for multiple concurrent Missions with
  multi-pane monitoring, bounded replay, daemon crash reconciliation, optional
  OS login startup, and reboot recovery without transferring live provider
  control.
- Expand provider tool-permission requests into richer Orbitkeep Airlocks with
  a consistent approve-once, approve-for-Mission, reject, and request-
  justification experience.
- Add Mission and Crew filtering, Flight Recorder exploration, result and
  artifact inspection, advanced Telemetry, and accessible keyboard controls.
- Complete removal of the temporary `session launch` compatibility tombstone
  after the documented pre-1.0 migration window.

Exit criteria:

- Live activity and replay show ordered, attributable Crew, tool, command,
  result, failure, and usage events without exposing secrets or hidden model
  reasoning.
- Graceful and forced pause and handover have observed, tested outcomes.
- Claude and Codex pass the same provider-neutral Mission UAT suite, with any
  unavoidable capability differences reported explicitly.
- Concurrent, detached, resumed, interrupted, malformed-stream, and supervisor
  recovery paths are tested on every supported host platform.

## v0.7 — Mission Modules and Airlocks

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

## v0.8 — Relay and federated Silos

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

## v0.9 — Graphical Mission Control and Telemetry

Scope:

- Deliver the graphical Mission Control client for Keep, Colony, Silo,
  Mission, Crew, Clearance, Airlock, and health management.
- Add live Mission and Run views with Crew activity, Flight Plan, result,
  artifact, file-change, and Flight Recorder drill-down.
- Provide graphical Airlock decisions, side questions, Course Corrections,
  graceful and forced pause, resume, handover, and cancellation over the same
  Core APIs and authorization boundaries as the CLI.
- Add Telemetry for tokens, cost, duration, throughput, rework, failures,
  provider/model performance, and Airlock outcomes.
- Provide human Go/No-Go and Course Correction workflows without allowing the
  UI to bypass Orbitkeep Core.
- Add alerting and operational dashboards for disconnected or unhealthy Silos.
- Preserve the CLI as a first-class interface for local development, SSH,
  automation, recovery, and accessibility.

Exit criteria:

- Every displayed decision and state links to its authoritative source.
- Telemetry distinguishes observed measurements from estimates.
- UI authorization is tested independently from workflow authorization.
- Equivalent CLI and graphical actions produce the same canonical transitions
  and Flight Recorder evidence.
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
- Headless provider streams, malformed or interrupted events, provider
  questions, tool-permission requests, and detach/reattach behavior once the
  provider control plane is implemented.
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
- The CLI and graphical Mission Control are equal clients of the same Core
  contracts; neither owns separate workflow truth.
- Provider interfaces are optional diagnostic surfaces. Orbitkeep owns the
  supported Mission experience and treats provider output as untrusted.
- Relay transports messages; it does not become canonical workflow state.
- Flight Recorder stores authoritative history; Telemetry is derived analysis.
- A Silo owns local execution truth and never claims an unobserved outcome.
- Central Charter may bound local policy; local policy may narrow but not
  silently expand those bounds.
- Airlocks fail closed for consequential actions and record every decision.
- Product terminology must not obscure canonical API or migration behavior.
