# Orbitkeep domain model

Orbitkeep is a distributed control plane for governed agent work. Its public
language uses a space-operations model while its v0.x persistence contracts
retain stable canonical names. Product terms are not permission shortcuts:
every operation still passes through the same validated state transitions,
ownership fencing, and evidence requirements.

## Hierarchy

```text
Orbitkeep
└── Keep
    ├── Mission Control
    ├── Charter
    ├── Relay
    ├── Telemetry
    ├── Flight Recorder
    └── Colonies
        └── Colony
            └── Silos
                └── Silo
                    ├── Local Charter
                    ├── Flight Director
                    ├── Crew Manifest and Crew
                    ├── Docking Adapters
                    ├── Missions
                    ├── Mission Modules and Airlocks
                    ├── Containment Bay
                    ├── Black Box
                    └── Local Flight Recorder
```

## Platform scopes

- **Keep:** one user, team, or organization's Orbitkeep environment and its
  top-level authority boundary.
- **Colony:** a logical product, program, or related group of repositories.
  A Colony may contain one or many Silos.
- **Silo:** one autonomous Orbitkeep-enabled repository or workspace. A Silo
  owns its local state and can perform bounded work during a Relay outage under
  its last valid Charter. It must not infer new authority while disconnected.
- **Mission Control:** the human-facing command interface. It invokes Orbitkeep
  APIs and cannot bypass Core, Airlocks, or Command Authority.
- **Charter:** policies, permissions, governance rules, roles, defaults, and
  resource constraints. A Local Charter may narrow central policy but cannot
  silently expand it.
- **Relay:** command, event, status, and handover transport between Mission
  Control and Silos. Redis is the planned initial implementation behind a
  transport interface. Relay delivery is not authoritative state.
- **Telemetry:** derived cost, token, performance, reliability, and workflow
  analytics. Derived values must retain source event references where possible.
- **Flight Recorder:** authoritative append-only audit and event history. Each
  Silo writes locally; a future central recorder ingests verifiable copies.

## Mission scopes

- **Mission:** a governed workflow pursuing one Mission Objective. The
  canonical v0.x record remains an `assignment`.
- **Mission Objective:** desired outcome and acceptance criteria.
- **Flight Plan:** proposed and approved strategy. The canonical record remains
  a `plan`.
- **Flight Director:** the manager agent holding current Command Authority.
- **Command Authority:** renewable, fenced ownership of Mission mutations.
- **Operation:** bounded specialist task within a Mission. The canonical record
  remains a `task`.
- **Mission Brief:** compact, versioned task packet supplied to a Mission
  Specialist.
- **Run:** one execution or rework attempt for an Operation. The canonical
  record remains an `execution`.
- **Mission Report:** structured specialist result with criterion-level
  evidence, findings, deviations, and blockers.
- **Clearance:** recorded Executive approval, rejection, revocation, expiry, or
  waiver. Mission Control may present approval and rejection as Go/No-Go.
- **Course Correction:** steering that creates or revises a Flight Plan and
  invokes materiality policy.
- **Beacon:** optional heartbeat proving that a Run remains observable. A
  missing Beacon never proves that a process stopped.

## Execution and safety

- **Mission Module:** isolated containerized environment for a Run. Modules are
  planned for v0.6 and are distinct from Silos: a Silo is a durable workspace;
  a Module is disposable compute.
- **Ingress Airlock:** validates the Mission Brief, provider, model,
  permissions, inputs, dependencies, and limits before a Module starts.
- **Egress Airlock:** validates write scope, redaction, evidence, and the
  Mission Report before output is accepted.
- **Launch Airlock:** requires the applicable Charter policy and human
  Clearance before consequential actions such as merge, publish, deploy, or
  external communication.
- **Docking Adapter:** provider connection for Claude, Codex, and future agent
  runtimes. An adapter reports capabilities and may not silently substitute a
  provider or model.
- **Containment Bay:** rejected or invalid submissions plus their original
  redacted content and validation errors. Resolution is recorded; failure
  history is not rewritten as success.
- **Black Box:** short-retention, redacted provider request and response
  captures used for diagnosis. It is not the canonical audit ledger.
- **Preflight:** installation and capability health checks performed by
  `orbitkeep doctor` and setup validation.
- **Mission Archive:** retained records for completed or cancelled Missions.

## Canonical compatibility

Orbitkeep v0.4.1 changes public terminology without rewriting existing data.

| Product term | Canonical v0.x concept |
| --- | --- |
| Silo | repository installation |
| Mission | assignment |
| Mission Objective | assignment objective |
| Flight Plan | plan |
| Flight Director | manager |
| Mission Specialist | specialist agent |
| Crew Manifest | role catalogue |
| Operation | task |
| Mission Brief | task packet |
| Run | execution |
| Mission Report | result |
| Clearance | approval |
| Command Authority | ownership lease and fencing token |
| Flight Rules | operating contracts |
| Flight Recorder | event ledger |
| Black Box | raw response store |
| Containment Bay | quarantine store |
| Beacon | heartbeat |
| Course Correction | steer command |
| Preflight | doctor and capability checks |

The `.agent-workflow/` and `.agent-state/` paths, JSON property names, event
types, actor types, role IDs, and published schema identifiers remain stable.
Future canonical renames require additive aliases, a migration specification,
and an announced compatibility window.
