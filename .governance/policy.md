# dev-stack policy

Local repository policy and direct user instructions retain precedence. This kit never grants merge, provider, credential or production authority.

## Core engineering principles

Apply these, the [code-quality review conditions](quality.md), and the [conditional principles](principles.md).
Read applicable leaves in full.

### Think before coding

- State assumptions and surface ambiguity and trade-offs before implementation.
- Ask when uncertainty materially changes the implementation.
- Push back on a worse design rather than silently choosing an interpretation.

### Simplicity first

- Write the minimum code that completely solves the requested problem.
- Do not add extra features, single-use abstractions, speculative flexibility, or error handling for impossible cases.
- If a substantially smaller implementation is equally clear and correct, rewrite toward it.

### Surgical changes

- Touch only what the task requires.
- Do not perform drive-by refactors, style cleanups, comment rewrites, or unrelated “while I’m here” changes.
- Match the existing style. Every changed line must trace to the request.

### Goal-driven execution

- Define a machine-checkable done condition before coding.
- Prefer: write a failing test that reproduces the bug or specifies the behavior, make it pass, then confirm no regressions.
- Continue until the defined behavior is verified; do not merely declare it fixed.

### Default posture

- Stay local to the task and avoid wandering through unrelated parts of the repository.
- Do not overthink edge cases in unfinished code or bloat APIs for hypothetical future needs.
- Understanding cannot be outsourced. Keep diffs small enough for a human to review completely.

## Delivery

Record intent, boundaries, source and acceptance criteria before implementation. Independently prove every criterion and the complete intent before scope success. Review code at every size; a 400-line feature diff triggers decomposition or recorded justification. Merge only with exact PR and target approval.
