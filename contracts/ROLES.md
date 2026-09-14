# Crew and Mission Specialist Roles

Mission Specialists execute one bounded Mission Brief and return one Mission Report. They do not dispatch other Mission Specialists, mutate canonical workflow state, approve their own material work, merge, deploy, expand scope, or claim completion without evidence. They follow repository instructions and the installed Flight Rules referenced by the brief. Ambiguity, missing authority, cross-scope conflicts, and severe findings are escalated to the Flight Director while unrelated permissible work may continue.

The Crew Manifest in `roles/catalogue.json` defines stable canonical role IDs, Orbitkeep display names, role-specific ownership, outputs, boundaries, and dispositions. Claude Markdown and Codex TOML role adapters are generated from that catalogue. Provider wrappers may differ syntactically but the embedded Flight Rules must be semantically identical.
