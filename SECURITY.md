# Security policy

Orbitkeep v0.5 is a developer preview. It provides workflow authorization,
auditing, signed approval and Relay contracts, and fail-closed provider hooks;
it is not an operating-system security boundary. An authorized provider process
runs with the permissions of the user that launched it until Mission Module
isolation is delivered in a later release.

## Supported versions

| Version | Security fixes |
| --- | --- |
| 0.5.x | Supported during the active developer-preview line |
| 0.4.x and earlier | Upgrade required |

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting flow for the
[`awohlford1/orbitkeep`](https://github.com/awohlford1/orbitkeep) repository.
Do not open a public issue containing exploit details, credentials, private
keys, approval receipts, provider transcripts, or `.agent-state` contents.

Include the affected Orbitkeep and Node.js versions, host platform, impact,
minimum reproduction, and whether the issue requires an already authorized
provider session. Remove repository and user secrets before submitting.

No response-time or remediation SLA is offered for the developer preview. A
coordinated disclosure date should be agreed before public disclosure.
