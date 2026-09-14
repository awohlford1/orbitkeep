# Orbitkeep Contracts

These files are Orbitkeep's provider-neutral Flight Rules, installed into a Silo at `.agent-workflow/contracts/`. The package copy is canonical; installed copies are immutable inputs for a specific framework release and should be replaced only by the installer or an explicit upgrade.

- `MANAGER.md` defines Flight Director command and Command Authority rules.
- `CONTRACTS.md` defines Mission Briefs and Mission Reports.
- `ROLES.md` defines the shared Mission Specialist lifecycle and Crew Manifest.

Provider-specific files are adapters generated from the same role catalogue. They must not introduce additional authority.
