---
name: principle-make-operations-idempotent
description: "Apply when designing commands, lifecycle steps, or processing loops that run amid crashes, restarts, and retries. Converge to the same end state regardless of partial prior runs."
---

# Make Operations Idempotent

Design operations so they converge to the correct state regardless of how many times they run or where they start from. Every state-mutating operation should answer: "What happens if this runs twice? What happens if the previous run crashed halfway?"

**Why:** Commands, lifecycle operations, and processing loops run where crashes, restarts, and retries are normal. If partial state changes the next run's outcome, every restart becomes a debugging session.

**The pattern:**
- Convergent startup: inspect existing state and reconcile only artifacts and sessions whose ownership is proven
- Content-based cleanup: compare by content equivalence, not creation order
- Conservative ownership: use native owned-process/sandbox evidence; PID existence, age and worker prose cannot reclaim capacity
- Idempotent scheduling: use fresh validated input when re-delegating corrections; reconcile prior effects and retain reservations while native state is unknown

**The test:**
1. What happens if this runs twice in a row?
2. What happens if the previous run crashed at every possible point?
3. Does re-execution converge to the same end state?

If any answer is "it depends on what state was left behind," the operation needs a reconciliation step.

Derived material copyright 2026 Lauren Tan under the [MIT licence](../../LICENSE.third-party). [Local policy and adaptation record](../../principles.md#provenance-and-local-adaptations).
