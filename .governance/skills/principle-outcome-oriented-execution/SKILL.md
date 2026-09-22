---
name: principle-outcome-oriented-execution
description: "Apply during planned rewrites and migrations with explicit phase boundaries. Converge on the target architecture; don't preserve smooth intermediate states with throwaway compatibility code."
---

# Outcome-Oriented Execution

Optimize for the intended, verifiable end state rather than preserving smooth intermediate states.

**Why:** Keeping every intermediate step fully stable often creates temporary compatibility code that becomes long-lived debt. Converge on the target architecture and prove correctness at explicit verification boundaries.

**Core rule:**
- Prioritize end-state integrity over transitional stability
- Intermediate breakage is acceptable when it is planned, scoped, and reversible
- Always run final verification before declaring done

**Guardrails:**
- Use this for planned rewrites and migrations with explicit phase boundaries
- Declare where temporary breakage is acceptable
- Keep high-signal checks for actively touched areas while migrating
- At plan completion prove every acceptance criterion and the intended outcome on the real artifact, with applicable required CI and minimum essential scope proof

## Local application

Temporary breakage stays inside the owned development phase, never shared staging or production. Every published/merged increment must meet its own applicable gates.

Derived material copyright 2026 Lauren Tan under the [MIT licence](../../LICENSE.third-party). [Local policy and adaptation record](../../principles.md#provenance-and-local-adaptations).
