---
name: self-verifying-delivery
description: Run an approved software scope through a bounded build, test, independent verification, repair, and human-report loop without changing acceptance to make the work pass.
---

# Self-verifying delivery

Use this skill for implementation after a human has separately accepted the durable request and its matching architecture/design. Start with [session initialisation](../session-initialisation/SKILL.md), then use [verification](../verification/SKILL.md) and [delivery](../delivery/SKILL.md) at their normal gates. This workflow coordinates those contracts; it does not replace them.

## Freeze the contract

Require accepted, committed and unchanged `docs/features/<slug>/request.md` and `design.md`. Create scope v2 with `tools/governance scope create --request REQUEST.md --design DESIGN.md --output .governance-artifacts/<slug>.scope.json`; this checks the matching revisions and records source identity without asking the human for a ref or SHA. Tests may translate the accepted semantics into executable checks, but neither the implementation pass nor the verifier may weaken, delete, skip or reinterpret an accepted criterion to obtain green output.

A material gap stops implementation and returns to the design gate. Increment and reaccept the design revision. Increment and reaccept the request revision only if intent, boundaries, assumptions, exclusions or acceptance criteria change; update the design's `requestRevision` whenever the request changes. Commit the accepted pair and create a fresh scope and baseline before resuming. Promote a cross-feature decision to the project's ADR convention when one exists, while retaining its decision ID in the feature design.

Create a project-local ignored ledger for one scope revision. Bind every observation to the candidate SHA and, when dirty, its patch proof; capture both from the checkout without asking the human to provide them. Use `.governance/self-verification.json` for iteration, repeated-failure, and elapsed-time bounds. The ledger is evidence routing, not evidence truth.

## Execute the graph

1. Establish the source-bound baseline and resolve its lead-review gaps.
2. Build acceptance checks that fail for the missing behavior and pass for the agreed outcome. Record unsupported or ambiguous proof as a gap, not a passing test.
3. Implement the smallest complete change.
4. Run the narrow direct checks, required project CI, and actual artifact or UI proof.
5. Verify every criterion and the whole intent independently of the implementation claim. Prefer a separate authorized review agent/session or CI boundary. If only the implementer can self-check, label that limitation and retain human or CI review as the independent gate.
6. Append exactly one classified observation to the ledger and run:

   `tools/governance loop inspect --scope SCOPE.json --record RUN.json --policy .governance/self-verification.json --ref REF --head SHA --patch clean`

   Use `sha256:...` instead of `clean` for a dirty candidate. Do not edit old observations; append a new iteration after the candidate or environment changes.
7. Follow only the returned route. Never continue after a terminal human gate without an approved revised scope.

## Route failures by owner

| Outcome | Route | Meaning |
| --- | --- | --- |
| `IMPLEMENTATION_DEFECT` | `build` | Change product code, produce a new candidate fingerprint, and re-run proof. |
| `SCOPE_GAP` | `human-design-review` | Stop. Decide whether the gap changes design only or also the request, revise the required documents and reaccept them. |
| `TEST_ORACLE_INVALID` | `human-acceptance-review` | The test contradicts or cannot prove accepted behavior; do not change code to satisfy a bad oracle. |
| `ENVIRONMENT_FAILED` | `repair-environment` | Repair or obtain the approved test environment without treating this as a product failure. |
| `BLOCKED` | `human-input` | Required authority, dependency, secret, decision, or external state is unavailable. |
| `SCOPE_VERIFIED` | `report` | Every criterion and the complete intent have source-bound evidence. |

Stop and escalate when the iteration, elapsed-time, or repeated-failure bound is reached. Reaching the configured same-failure limit requires premise review before another fix. A green check does not override a scope gap, source mismatch, missing proof, or human approval boundary.

## Complete

On `report`, inspect the actual diff and artifact, update the scope-owned documentation and PR description, and give the human a criterion-by-criterion report with a readable candidate reference, checks run, evidence locations, limitations, residual risks, and exact actions still requiring approval. Keep machine identities in the evidence artifacts unless the human asks for them. Do not merge, publish, deploy, provision, or activate providers or workers without their separate explicit authority.
