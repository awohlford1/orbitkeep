# Public SDK boundary

Orbitkeep v0.5 exposes a provider-neutral JavaScript and TypeScript SDK for the
CLI, integrations, and future platform clients. The supported import surface is
the package root and the subpaths declared in `package.json` under `exports`.
Imports from `orbitkeep/dist/*`, `orbitkeep/src/*`, or other undeclared paths
are internal and unsupported.

The root export supplies versioned namespaces and commonly used installer,
upgrade, validation, and error APIs. Explicit subpaths are available for
contracts, configuration, policy, commands, storage, evidence, provider
adapters, installation, scheduling, workflows, Silo identity and lifecycle,
and Relay contracts. JSON Schema and bundled workflow-template exports are
content-addressable package assets rather than mutable runtime state.

Every JavaScript export in the packed package must have a TypeScript declaration
and load from a clean consumer installation. The release gate rejects missing
targets, unexpected files, internal specifications, secrets, oversized
artifacts, and package/version drift.

Orbitkeep remains pre-1.0. Patch releases preserve the documented v0.5 surface
except for security corrections; a minor release may revise it when the
changelog and migration path identify the change. Canonical record schema
versions remain independent of the npm package version.

Transport-neutral SDKs do not imply a durable service. In v0.5 the Relay and
Silo registration reference adapters are in-memory contract implementations.
They must not be represented as authenticated, durable Keep infrastructure.
