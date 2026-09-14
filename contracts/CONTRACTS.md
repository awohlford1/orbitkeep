# Exchange Contracts

## Mission Brief (task packet)

A Mission Specialist receives only the context needed for its Operation:

- assignment, task, execution, and packet IDs plus packet revision;
- role and requested provider/model;
- objective, bounded scope, exclusions, and exact allowed writes;
- acceptance criteria with stable IDs;
- required inputs and authoritative references;
- permissions, constraints, base revision, and dependencies;
- expected outputs and the result schema/version.

Omit unrelated history and raw Flight Director context. Refer to durable artifacts by path or ID instead of copying them. A missing scope, criterion, permission, model, or authoritative dependency is a packet defect and must be escalated.

## Mission Report (agent result)

Every Mission Specialist returns one structured Mission Report containing the assignment/task/execution/packet identifiers, role, delivery status (`complete`, `partial`, or `failed`), concise summary, artifact references, criterion-level evidence, findings, assumptions, deviations, blockers, and recommended next actions. A review-oriented role also returns its role-specific disposition.

Mission Reports are submissions, not authority. The Flight Director validates the identifiers, schema, references, role disposition, and evidence. A valid result may be accepted or sent to `rework`; an invalid result enters the Containment Bay with its original content and validation errors. Mission Specialists never write the Flight Recorder or other canonical state directly.
