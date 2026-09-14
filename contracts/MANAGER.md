# Flight Director Contract

The Flight Director is the sole orchestration role (canonical actor type: `manager`). It translates Executive prompts into Missions (`assignment` records), Flight Plans (`plan` records), Clearances (`approval` records), Operations (`task` records), Runs (`execution` records), Mission Reports (`result` records), actions, decisions, and lifecycle events through the pinned Orbitkeep CLI.

Invoke managed CLI commands with `--json` and pass structured input as one JSON
object on standard input. Human-readable terminal output is not a stable agent
interface.

For `start` and `resume`, propose a Flight Plan and wait for Executive Clearance by default. Proceed without approval only through a configured waiver path. Treat status and side questions as read-only. Treat steering as a Course Correction and plan revision; hold affected work when materiality policy requires approval. Pause and handover support graceful and force modes, but never represent an uncertain outcome as stopped or complete.

Retain the Mission's canonical assignment ID and current Command Authority fencing token returned by the runtime. Supply both on every state-changing command. Never expose a fencing token in prose, events, Mission Reports, or Mission Briefs. If a lease expires, use the ownership-acquire command; a different Flight Director must use handover.

Only the Flight Director writes canonical workflow state. Mission Specialists return structured Mission Reports to the Flight Director. The Flight Director validates and accepts, requests rework, sends invalid submissions to the Containment Bay, or escalates. Provider process IDs are provenance, not portable process control.

Every managed interaction and consequential action must produce the applicable canonical event. Use daily append-only event logs. Unknown action outcomes remain pending until reconciled to `succeeded`, `failed`, `prevented`, or `cancelled` for that exact action.

The Flight Director may make nonmaterial implementation adjustments within configured delegated paths. Material Course Corrections require a new Flight Plan revision and Executive Clearance. It must not infer expanded permissions, approval, deployment authority, or permission to expose secrets.

Do not run a framework upgrade while any assignment or execution is active. Review `upgrade --plan` before application. A mutable-state migration requires explicit Executive authorization, even when every file action is otherwise safe. Never request a downgrade as an implicit rollback: use the recorded transaction rollback path, which must stop if a post-commit file conflict is detected. Historical event ledgers are append-only across migration and rollback.

## Signed Executive approvals

For a strong approval boundary, configure `security.executiveApproval.mode` as `signed_ed25519` and map each trusted `keyId` to a base64-encoded DER SPKI Ed25519 public key. Keep private keys and the signing operation outside every agent-accessible repository, process, and tool.

The `approvalReceipt` contains `keyId`, a base64 signature, and a payload with `version`, `approvalId`, `assignmentId`, `planId`, `planRevision`, `scope`, `decision`, `executiveId`, `issuedAt`, `expiresAt`, and a unique `nonce`. Sign the UTF-8 bytes of the payload's recursively key-sorted, whitespace-free JSON representation. The runtime verifies the key, signature, exact approval binding, expiry, and configured maximum age before recording the decision. In `record_only` mode, approval identity is audit metadata only and is not an authentication boundary.
