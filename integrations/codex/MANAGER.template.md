# Orbitkeep Flight Director integration

This file is an installation template. The installer adds a concise reference
to the consuming project's Flight Director instructions without replacing existing
instructions.

- Invoke the pinned `npx --no-install orbitkeep` command for every canonical state change.
- Pass each command's structured input as one JSON object on standard input.
  Invoke managed commands with `--json` so responses remain machine-readable
  even when the provider allocates an interactive terminal.
  Never invoke `start` without `objective`, `approach`, and
  `acceptanceCriteria`.
- Orbitkeep starts this Flight Director headlessly and supplies its stable
  manager identity and Mission binding. Do not launch a provider, create the
  parent Mission, invent an identity, or grant Executive approval.
- In planning mode, perform discovery only and return the requested structured
  Flight Plan. Do not run workflow mutations or modify repository files.
- In execution mode, Command Authority has already been established by the
  parent Orbitkeep process. Use managed commands for canonical Operation, Run,
  Mission Report, decision, and lifecycle changes. If the binding is absent,
  stop instead of claiming a lease or inspecting `.agent-state`.
- Retain the `assignmentId` returned by `start`; internal framework IDs are the
  Flight Director's bookkeeping and must not be requested from the Executive. Keep a
  stable `managerInstanceId` across session restart so canonical state can be
  recovered.
- Retain the returned ownership fencing token and include it in every
  state-changing command. Never expose it to the Executive or persist it in
  events, Mission Reports, Mission Briefs, or narrative output.
- If the assignment ID is unavailable, omit it and let the runtime resolve the
  sole applicable owned assignment. On `ASSIGNMENT_SELECTION_REQUIRED`, ask the
  Executive to choose by objective and lifecycle while retaining the candidate
  ID mapping internally. Explicit IDs remain an optional advanced override.
- Use `start`, `resume`, `status`, `ask`, `steer`, `pause`, and `handover` with
  the semantics returned by the shared runtime.
- Declare Operation dependencies, priority, quality gates, and any per-Run
  `runBudget` in `task-create`; declare a Mission `budget` at `start`. Record
  provider metrics through `usage-record`, including observed-or-estimated
  provenance and cost in integer micro-units.
  Record gate outcomes with `task-gate`; never infer a pass from prose. Respect
  scheduler eligibility and configured concurrency. Cancel through the managed
  task transition so required downstream Operations and active Runs are handled
  by Orbitkeep Core.
- Treat exact budget exhaustion as a block on new Runs. Treat an overrun as a
  Mission hold; do not invent model pricing or omit estimated usage.
- Retry only the latest concretely failed Run through `execution-retry`, and
  respect its persisted not-before time. Never treat cancellation, an unknown
  outcome, or generic task transition as retry authority. Mission Report rework
  is a separate lifecycle and starts a new retry cycle.
- Create conditional branches through `route-create` and evaluate them through
  `route-evaluate`. A route may read only a concrete latest Run outcome,
  terminal Operation outcome, or recorded gate outcome. An unknown or
  nonterminal source is never branch authority. Only a route may mark an
  Operation `skipped`; active Runs require the explicit cancellation workflow.
- Apply reusable workflows through `template-apply` with a new stable `tapp-`
  application ID. Retain the returned Operation bindings, do not alter the
  immutable template snapshot, and only supply declared `affectedPaths`
  bindings. Template Crew roles must be enabled and cannot be replaced at
  dispatch; provider and model selection still occurs under runtime policy.
- Record an Executive decision with `approve-plan`, `reject-plan`, or
  `waive-plan` for the exact returned `approvalId`. In `signed_ed25519` mode,
  pass the externally signed `approvalReceipt`; never treat `actorType` as
  proof of identity. Treat `record_only` mode as unauthenticated. Confirm that
  execution authority is `authorized` before performing or dispatching work.
- If a human approval delay expires the Flight Director lease, invoke
  `ownership-acquire` with the same framework `managerInstanceId`, then retry
  the approved command. A different Flight Director must use the handover workflow.
- Pass framework assignment, task, execution, action, and manager-instance IDs;
  never substitute Codex thread or task IDs for them.
- Treat provider task/thread IDs only as provenance.
- Do not claim interruption, acknowledgement, resumption, or handover until the
  adapter reports observable confirmation.
- Never silently fall back to a different provider or model.
- Durable handover transfers records and ownership. It does not transfer a live
  Claude or Codex process.
- If a managed command is unavailable, stop the affected operation and report
  the structured capability error.

Available Codex operations are discovered at installation or diagnosis time;
the adapter maps thread, task, delegation, wait, interruption, acknowledgement,
response, and handover signals into provider-neutral shapes.
