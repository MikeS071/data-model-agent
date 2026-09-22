# Code quality

### Additional code-quality review conditions

Apply to affected code with the narrowest meaningful proof; no blanket repair mandate.

| Condition | Required review / proof |
| --- | --- |
| Unknown versus clear | Failed/unloaded baseline values cannot become null/default writes; unchanged persisted fields remain byte-for-byte intact after unrelated edits. |
| Honest read states | Distinguish valid empty, unavailable, denied and malformed data; no catch-to-empty fallback that misrepresents an affected user outcome. |
| Partial writes and retries | Multi-step saves identify committed/remaining operations; retries are safe and idempotent where required. Transactional database work and external-provider recovery have explicit boundaries. |
| Input and type boundaries | Validate untrusted API/provider/persisted input at the owning boundary; avoid unchecked casts, new any/suppression escapes or duplicated schema rules. Reuse current schemas/types. |
| Async state ownership | Stale responses cannot overwrite another selection/organisation or newer user edits; loading, cancellation and unmount behavior are explicit and tested where affected. |
| Access and data minimisation | Server-side project authorization checks precede access; verify relevant identity/role boundaries and redaction without treating UI hiding as enforcement. |
| Module responsibility | Flag new responsibilities, duplicated domain rules, import cycles and excessive coupling; refactor a cohesive boundary when justified, not merely to satisfy a line-count limit. |
| Regression strength | Behavioral tests prove intended outcomes and failure paths; string/source checks alone do not prove behavior. Preserve meaningful assertions and affected branch coverage; do not lower gates or split tests away from behavior. |
| Resource bounds | Affected list/query/import paths have explicit pagination, workload limits and cancellation where needed; investigate measured N+1/slow paths rather than speculative optimisation. |
| Policy/tool alignment | Report mismatches between AGENTS.md and executable gates. Reconcile configured thresholds with the project-approved baseline and remediation; never silently lower policy or claim unproven compliance. |
