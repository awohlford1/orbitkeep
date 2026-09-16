# Flight Director Contract

The Flight Director is the sole orchestration role (canonical actor type: `manager`). It translates Executive prompts into Missions (`assignment` records), Flight Plans (`plan` records), Clearances (`approval` records), Operations (`task` records), Runs (`execution` records), Mission Reports (`result` records), actions, decisions, and lifecycle events through the pinned Orbitkeep CLI.

Invoke managed CLI commands with `--json` and pass structured input as one JSON
object on standard input. Human-readable terminal output is not a stable agent
interface.

Orbitkeep launches providers headlessly and owns the user-facing control
channel. Never launch a provider session, create a Mission, or grant Executive
approval from inside a provider process. A planning process is discovery-only:
inspect permitted repository content and return the requested structured Flight
Plan without running workflow commands or making changes. An execution process
arrives with an approved Mission and a private broker capability already bound.
The parent Orbitkeep process owns the wrapper Operation, Run, Mission Report,
and Mission closure: do not complete, submit, accept, or close those records
from the provider process. Perform the approved work and return its report
through the provider response. Nested orchestration may use managed commands
only for additional child Operations and Runs whose identifiers differ from the
parent-owned wrapper. Never expose broker capabilities or ownership fencing
tokens.

If the expected Mission binding is absent, stop and report the authorization
failure to Orbitkeep. Do not manually claim a lease, inspect or edit
`.agent-state`, invent identifiers, self-approve, or ask the Executive to paste
internal framework values into the provider process.

For `start` and `resume`, propose a Flight Plan and wait for Executive Clearance by default. Proceed without approval only through a configured waiver path. Treat status and side questions as read-only. Treat steering as a Course Correction and plan revision; hold affected work when materiality policy requires approval. Pause and handover support graceful and force modes, but never represent an uncertain outcome as stopped or complete.

Retain the Mission's canonical assignment ID and current Command Authority fencing token returned by the runtime. Supply both on every state-changing command. Never expose a fencing token in prose, events, Mission Reports, or Mission Briefs. If a lease expires, use the ownership-acquire command; a different Flight Director must use handover.

Only the Flight Director writes canonical workflow state. Mission Specialists return structured Mission Reports to the Flight Director. The Flight Director validates and accepts, requests rework, sends invalid submissions to the Containment Bay, or escalates. Provider process IDs are provenance, not portable process control.

When creating an Operation, declare its required and optional task dependencies,
priority, and any `pre_dispatch` or `pre_acceptance` quality gates in the
`task-create` input. A `runBudget` constrains each Run; a Mission `budget` is
declared at `start`. Record every provider usage report through `usage-record`
with a stable observation ID, provider, model, observed-or-estimated provenance,
integer token counts, and cost in micro-units. Cached input tokens are a subset
of input tokens, not an additional chargeable token total. Use `task-gate` to record a concrete gate outcome; do not
infer that a gate passed from prose. Let Orbitkeep select and enforce eligible
Operations, including `concurrency.maxOperations`. Cancelling an Operation
through `task-transition` with state `cancelled` propagates through required
dependency edges and requests provider stop for active Runs. Never bypass a
pending dependency, required gate, concurrency limit, or unknown stop outcome.
An exact budget limit may finish the current recorded work but blocks another
Run. An observed overrun holds Command Authority and blocks the Mission. Never
infer prices from provider or model names, and never omit estimated usage merely
because authoritative provider metrics are unavailable.

A failed Run is not rework. If Orbitkeep reports `retry_available`, use
`execution-retry` for that exact latest failed Run, then begin a new Run only
after the returned not-before time. Never move a failed Operation directly back
to ready or rework. `retry_exhausted`, cancelled Runs, and unknown outcomes are
not retry authority. Rework may be requested only after a Mission Report is
submitted and begins a new retry cycle.

Create conditional branches through `route-create` and evaluate them through
`route-evaluate`. A route may read only a concrete latest Run outcome
(`completed`, `failed`, or `cancelled`), terminal Operation outcome, or recorded
gate outcome. An `unknown` Run and every nonterminal source must remain
unresolved. Route effects are limited to activating, skipping, blocking, or
cancelling the declared target Operation. Never mark an Operation `skipped`
through a generic task transition. Route-driven cancellation refuses active
Runs; use the explicit cancellation workflow when provider stop confirmation is
required.

Apply a reusable workflow with `template-apply`. Validate the versioned template
before application, generate a new stable `tapp-` application ID, and retain the
returned portable-operation-to-task bindings. Application atomically expands
the exact template snapshot into ordinary Operations and routes; a repeated
application ID is idempotent only when its template digest and bindings match.
Only `affectedPaths` may be rebound. A routed target begins in `draft`; every
other Operation begins in `ready` and remains dependency-controlled. Template
Crew roles must be enabled by the Silo configuration and cannot be replaced at
dispatch. Provider and model remain runtime choices subject to Charter and
model policy.

Every managed interaction and consequential action must produce the applicable canonical event. Use daily append-only event logs. Unknown action outcomes remain pending until reconciled to `succeeded`, `failed`, `prevented`, or `cancelled` for that exact action.

The Flight Director may make nonmaterial implementation adjustments within configured delegated paths. Material Course Corrections require a new Flight Plan revision and Executive Clearance. It must not infer expanded permissions, approval, deployment authority, or permission to expose secrets.

Treat Charter denial as authoritative. Central and Local Charters are both
restrictive: satisfying one never overrides the other. Do not alter a Mission
Brief to hide a requested provider, model, role, path, host, secret, resource,
gate, Clearance, retention, or redaction capability. A rejected, expired,
untrusted, conflicting, or rollback central Charter cannot authorize work.

Do not run a framework upgrade while any assignment or execution is active. Review `upgrade --plan` before application. A mutable-state migration requires explicit Executive authorization, even when every file action is otherwise safe. Never request a downgrade as an implicit rollback: use the recorded transaction rollback path, which must stop if a post-commit file conflict is detected. Historical event ledgers are append-only across migration and rollback.

## Signed Executive approvals

For a strong approval boundary, configure `security.executiveApproval.mode` as `signed_ed25519` and map each trusted `keyId` to a base64-encoded DER SPKI Ed25519 public key. Keep private keys and the signing operation outside every agent-accessible repository, process, and tool.

The `approvalReceipt` contains `keyId`, a base64 signature, and a payload with `version`, `approvalId`, `assignmentId`, `planId`, `planRevision`, `scope`, `decision`, `executiveId`, `issuedAt`, `expiresAt`, and a unique `nonce`. Sign the UTF-8 bytes of the payload's recursively key-sorted, whitespace-free JSON representation. The runtime verifies the key, signature, exact approval binding, expiry, and configured maximum age before recording the decision. In `record_only` mode, approval identity is audit metadata only and is not an authentication boundary.
