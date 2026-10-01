# Engineering principle skills

These conditional principles supplement the five unconditional AGENTS principles.
At scope/design, implementation, review and completion, select by the triggers below
and **read the applicable leaf SKILL.md in full** before applying it. Load only
relevant leaves; a summary or name is not the full instruction.

The existing source-bound review consumes this table and the complete leaf content.
For code at every size, record a satisfied/violation/unverified disposition or a
scope-specific reason for not-applicable for each conditional principle. The five
general AGENTS principles remain mandatory for all code. Evidence must address
the user's intent and every scope criterion; a hash cannot prove judgment or reading.

Local adaptations preserve scoped native delegation where permitted, guarded external worker activation, protected approvals, native
ownership, source isolation and minimum essential scope proof. Use existing tools;
do not create speculative abstractions, mandatory prototype campaigns or extra tests.
Principles guide approved work; they do not expand scope or grant operational authority.

## Core

| Principle | Applies when |
| --- | --- |
| [Laziness Protocol](skills/principle-laziness-protocol/SKILL.md) | Apply when refactoring, evaluating diff size, or tempted to add abstractions, layers, or signal threading. Bias toward deletion and the smallest change that solves the problem. |
| [Foundational Thinking](skills/principle-foundational-thinking/SKILL.md) | Apply before writing logic: choosing core types and data structures, sequencing scaffold-vs-feature work, asking what concurrent actors share. Get the data structures right so downstream code becomes obvious. |
| [Redesign From First Principles](skills/principle-redesign-from-first-principles/SKILL.md) | Apply when integrating a new requirement into an existing design. Redesign as if the requirement had been a foundational assumption from day one, instead of bolting it on. |
| [Attack the Premise](skills/principle-attack-the-premise/SKILL.md) | Apply when two or more fixes that share one premise have failed the same gate. Take a census of which actors hold the imbalance before the next fix, then question the premise instead of writing another fix that assumes it. |
| [Subtract Before You Add](skills/principle-subtract-before-you-add/SKILL.md) | Apply when sequencing an addition, refactor, or rewrite. Remove dead code, redundant validators, and stub references first, then build on the simpler base. |
| [Minimize Reader Load](skills/principle-minimize-reader-load/SKILL.md) | Apply when reviewing or shaping code that's hard to trace. Count layers between question and answer, and hidden state in the reader's head; collapse one-caller wrappers and shrink mutable scope. |
| [Outcome-Oriented Execution](skills/principle-outcome-oriented-execution/SKILL.md) | Apply during planned rewrites and migrations with explicit phase boundaries. Converge on the target architecture; don't preserve smooth intermediate states with throwaway compatibility code. |
| [Experience First](skills/principle-experience-first/SKILL.md) | Apply when product, UX, or feature-scope tradeoffs come up. Choose user delight over implementation convenience; ship fewer polished features over more rough ones. |
| [Exhaust the Design Space](skills/principle-exhaust-the-design-space/SKILL.md) | Apply when facing a novel UI interaction or architectural decision with no precedent in the codebase. Build 2-3 competing prototypes and compare side by side before committing. |
| [Build the Lever](skills/principle-build-the-lever/SKILL.md) | Apply to any non-trivial work, not just bulk work: edits, migrations, analyses, checks. Build the tool that does it or proves it (codemod, script, generator, or a skill your subagents follow) instead of working by hand. The tool is the artifact a reviewer can rerun. |

## Architecture

| Principle | Applies when |
| --- | --- |
| [Model the Domain](skills/principle-model-the-domain/SKILL.md) | Apply when writing stateful logic, or when code branches a lot or repeats a shape assumption across files. Encode the domain in a structure instead of scattered conditionals. |
| [Boundary Discipline](skills/principle-boundary-discipline/SKILL.md) | Apply when wiring validation, error handling, or framework adapters. Concentrate guards at system boundaries (CLI, config, network, external APIs); trust internal types and keep business logic in pure functions. |
| [Type System Discipline](skills/principle-type-system-discipline/SKILL.md) | Apply when designing types, reviewing a function signature, or writing code in any statically-typed language. Make illegal states unrepresentable, brand semantic primitives, parse external data at boundaries, refuse to lie to the compiler, exhaust variants, derive from authoritative schemas. |
| [Make Operations Idempotent](skills/principle-make-operations-idempotent/SKILL.md) | Apply when designing commands, lifecycle steps, or processing loops that run amid crashes, restarts, and retries. Converge to the same end state regardless of partial prior runs. |
| [Migrate Callers Then Delete Legacy APIs](skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md) | Apply when introducing a new internal API while old callers still exist. Migrate callers and delete the old API in the same wave instead of preserving compatibility layers. |
| [Separate Before Serializing Shared State](skills/principle-separate-before-serializing-shared-state/SKILL.md) | Apply when concurrent actors might write to the same file, branch, key, or state object. Eliminate the sharing first; serialize structurally only when one shared writer is a real invariant. |

## Verification

| Principle | Applies when |
| --- | --- |
| [Prove It Works](skills/principle-prove-it-works/SKILL.md) | Apply after completing a task, before declaring done. Verify against the real artifact (run the feature, read the actual value, inspect the diff), not a proxy, self-report, or 'it compiles.' |
| [Fix Root Causes](skills/principle-fix-root-causes/SKILL.md) | Apply when debugging. Trace each symptom to its root cause and fix it there; reproduce first, ask why until you reach it, resist nil-check guards that silence crashes. |
| [Sequence work into verifiable units](skills/principle-sequence-verifiable-units/SKILL.md) | Apply to multi-step work (sweeps, migrations, runs of similar edits) and to how you stack commits and PRs. Break work into small units that each end in a verifiable state, check each before the next, and order delivery so the sequence proves itself to a reviewer. |
| [Test Behavior, Not Implementation](skills/principle-test-behavior-not-implementation/SKILL.md) | Apply when you write, change, or keep a test. Call the code the way its users do and assert the result they observe against a literal expected value. If the test would still pass when every imported function returns undefined, rewrite the assertion or delete the test. |

## Delegation

| Principle | Applies when |
| --- | --- |
| [Guard the Context Window](skills/principle-guard-the-context-window/SKILL.md) | Apply when context is filling up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents; keep summaries in the main thread, not raw payloads. |
| [Never Block on the Human](skills/principle-never-block-on-the-human/SKILL.md) | Apply when tempted to ask 'should I do X?' on reversible work. Proceed, present the result, let the human course-correct after the fact; retain protected approval boundaries. |

## Meta

| Principle | Applies when |
| --- | --- |
| [Encode Lessons in Structure](skills/principle-encode-lessons-in-structure/SKILL.md) | Apply when you catch yourself writing the same instruction a second time, or notice a recurring correction. Encode the rule as a lint, metadata flag, runtime check, or script instead of more text. |

## Provenance and local adaptations

All 23 leaves retain material copyright 2026 Lauren Tan under the
[MIT licence](LICENSE.third-party). The [adaptation rationale](docs/rationale.md) explains
the programme context. No other plugin skills, scripts, runtime, provider or automatic
updates are installed.

The leaves remove editor-specific invocation metadata. Local changes are: authorisation
and scoped delegation instead of unrestricted fan-out/review-after-publishing;
native ownership instead of PID-based stale reclamation; scoped deletion/migration
and explicit external compatibility; minimum essential verification instead of
blanket campaigns; reuse of existing tools and task records; preservation of meaningful
negative tests; evidence-based premise analysis and appropriate heuristic limits.
Leaf-specific application notes and wording carry those changes in full.

One native engineering-principles router supports discovery; canonical leaves and
this catalogue stay under `.governance/`. Installation preserves licences, links,
source-bound review and the worker's protected governance boundary.
