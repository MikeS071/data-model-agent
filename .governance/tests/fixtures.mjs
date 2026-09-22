export const sha = 'a'.repeat(40);

export function scopeFixture({
  ref = 'feature/task',
  sourceSha = sha,
  intent = 'Deliver a synthetic feature',
  intentSource = 'docs/features/synthetic-feature/request.md',
  boundaries = 'Fixture only.',
  assumptions = ['Synthetic fixture.'],
  exclusions = ['No external actions.'],
  criteria = [{ id: 'A', outcome: 'Complete A', method: 'Focused proof' }],
  slug = 'synthetic-feature',
  revision = 1,
  requestRevision = 1,
} = {}) {
  return {
    version: 2,
    revision,
    intent,
    intentSource,
    boundaries,
    assumptions,
    exclusions,
    documents: {
      slug,
      request: { path: `docs/features/${slug}/request.md`, revision: requestRevision },
      design: { path: `docs/features/${slug}/design.md`, revision, requestRevision, decisions: ['D-001'] },
    },
    source: { ref, sha: sourceSha },
    criteria,
  };
}

export function requestDocument({ slug = 'synthetic-feature', status = 'accepted', revision = 1 } = {}) {
  return `---
kind: request
version: 1
revision: ${revision}
status: ${status}
slug: ${slug}
---

# Synthetic feature

## Intent

Deliver the accepted synthetic behavior.

## Intent source

Direct user acceptance.

## Boundaries

- Fixture files only.

## Assumptions

- The fixture is local.

## Exclusions

- No external actions.

## Acceptance criteria

### A

**Outcome:** Complete A for the fixture.

**Proof:** Run the focused fixture proof.

## Approval

Status: ${status}. Explicit human decision recorded in the fixture.
`;
}

export function designDocument({ slug = 'synthetic-feature', status = 'accepted', revision = 1, requestRevision = 1 } = {}) {
  return `---
kind: design
version: 1
revision: ${revision}
status: ${status}
slug: ${slug}
requestRevision: ${requestRevision}
---

# Synthetic feature design

## Context

The fixture needs one deterministic behavior.

## Chosen approach

Use one pure function and one boundary.

## Alternatives considered

An external service was rejected.

## Component diagram

\`\`\`mermaid
flowchart LR
  A[Input] --> B[Output]
\`\`\`

## Data-flow diagram

\`\`\`mermaid
sequenceDiagram
  Input->>Output: value
\`\`\`

## Domain model

One input maps to one output.

## Storage model

No persistent storage.

## External boundaries

Validate the input once.

## Security and privacy

No secrets or external data.

## Failure modes

Invalid input is refused.

## Verification strategy

Run the focused proof.

## Rollout and rollback

Revert the feature commit.

## Design decisions

| ID | Decision | Rationale | Alternatives | Consequences |
| --- | --- | --- | --- | --- |
| D-001 | Use a pure function. | It is deterministic. | External service. | The fixture stays local. |

## Approval

Status: ${status}. Explicit human decision recorded in the fixture.
`;
}
