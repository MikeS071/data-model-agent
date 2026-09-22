# Operational recipes

Use `tools/governance --help` for the exact command interface. Record the scope's
intent and acceptance criteria first. Keep plans, source-bound review records and
usage evidence in ignored `.governance-artifacts/`; retain no secrets or private logs.

1. Draft, explicitly accept and commit `docs/features/<slug>/request.md`; then draft,
   separately accept and commit the matching `design.md`. Use the installed templates.
2. Create scope v2 from the accepted pair with `scope create`, validate scope/config,
   run baseline against the intended source and review every reported gap. Then create a
   reviewed action plan using the project's delivery
   adapter, then explicitly apply it under already established authority. Read back.
3. Implement a small scope. Run relevant committed verification commands. Create
   `review plan`/`review check` against both the review base and delivery target.
   Missing proof, changed policy or an unintegrated base cannot become ready.
4. For a self-verifying delivery, use the canonical `self-verifying-delivery` skill.
   Append each source-bound outcome to one ignored ledger, then run `loop inspect` with
   the actual head and `clean` or the dirty patch proof. Follow its typed route. Product
   defects may loop to build; scope/oracle gaps return to human acceptance; environment
   failures stay outside product repair. A material gap stops for document revision and
   reacceptance before a fresh scope/baseline. Stop at configured iteration, elapsed or repeated
   failure bounds. Only `SCOPE_VERIFIED` can return `report`.
5. Optionally build a compact `review bundle` with the complete diff, selected full
   principle leaves, criterion/check mapping, independently assessed evidence and
   complete measured usage. High reasoning requires a concrete reason; no review
   token/dollar budget is enforced. `usage snapshot`, `usage collect` and `usage report`
   distinguish actual counts from unknowns. Recorded prices are not a live quote.
6. Reconcile issue/parent/queue. Obtain exact PR/target approval before any merge.
   This package does not implement merge, production promotion or provider setup.

Upgrade invokes `plan` from the new release and then `apply --target PROJECT`; the private
pending plan binds the exact release and adapter automatically. A local modification
blocks overwrite. `remove --target PROJECT` records a readable pending removal plan;
`apply --target PROJECT` removes owned files and exact managed sections after review.
User additions outside sections survive.
Rollback explicitly restores the previous transaction; conflicts stop before overwrite.
An interrupted apply keeps its private transaction. `recover --target PROJECT` resumes
only if every file still matches either its recorded before or after bytes. Verify after
recovery. Do not remove locks, receipts or backups to bypass uncertainty.
