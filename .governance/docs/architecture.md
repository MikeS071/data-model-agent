# ADR 1: One portable core with explicit project adapters

Status: proposed for the initial private release.

Keep authored contracts, commands, worker lifecycle, policy and full skills under
`.governance/`. Native tools and skill entrypoints route there. Reuse the accepted
implementation contracts with recorded machine source identities; do not fork an additional runner
or copy application history. Project identity, delivery conventions and real
verification commands are explicit versioned inputs.

The installer consumes a trusted reviewed release and owns only declared files plus
marked policy sections. It verifies manifest identities internally and can optionally
accept an external release pin for advanced distribution workflows; normal users do not
copy hashes. It cannot overwrite a project's stronger policy, configure providers,
activate workers or grant publishing authority. A readable plan stores its exact release,
adapter and target binding in an installer-managed pending artifact; `apply` recomputes
that binding before any target write. Backups and explicit recovery handle interrupted
local writes.

After private publication, dev-stack is the authoritative portable source. Each adoption
is a separately reviewed pinned-release change preserving project adapters and acceptance
records. This avoids unversioned copying and a full application template. The tradeoff is that
each project must configure and prove its own verification and host capabilities.

## ADR 2: Bounded self-verification is a typed state machine

Status: proposed for the next private candidate.

The implementation loop composes the existing scope, baseline, verification, review and
delivery contracts. It does not create a second delivery engine. A source-bound append-only
ledger records one classified observation per iteration; `loop inspect` validates that
record and returns the next route. Product defects return to build. Scope gaps and invalid
test oracles return to human acceptance. Environment failures remain separate from product
failures. Blocked work waits for human input. Only complete criterion and intent evidence
can route to reporting.

Iteration, elapsed-time and repeated-failure limits prevent optimistic infinite repair.
The verifier should be distinct from the implementer when an authorized independent agent,
session or CI boundary exists. The record never proves its own evidence and never grants
scope change, merge, publication, deployment, provider or worker authority.
