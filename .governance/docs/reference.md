# Configuration and support

Canonical source lives under `.governance/`; `tools/` and `.agents/skills/` are native
entrypoints. Root AGENTS/.gitignore receive marked managed sections; their other bytes
remain project-owned. No application files, package.json, CI, user settings or hooks
are overwritten by the installer. Unknown files are not installer-owned.

`project.json`: schemaVersion=1, repository=`owner/name`, allowed branchPrefixes.
`delivery.json`: schemaVersion=1, project, baseBranch, queue (positive issue number or
null), instructionPaths, and issue/pr template paths. The packaged adapters include root
AGENTS plus canonical policy, quality and principle files. Their bytes bind action-plan
freshness and their content is included in compact review bundles.
`verification.json`: schemaVersion=1 and a map of check IDs to program/argument arrays.
Supported explicit programs: node, python3, git, pnpm, npm, go, cargo. Installation checks
Node/Python/Git; other configured tools must already exist when invoked. Commands are
reviewed project code and can have side effects: scope authority remains necessary.
No downloaded shell commands or worker-supplied checks are evaluated.

`self-verification.json`: schemaVersion=1 plus positive `maxIterations`,
`maxSameFailure` and `maxElapsedMinutes`. `loop inspect` accepts a scope, this policy,
an append-only run ledger, the independently observed current ref/head, and `clean` or
a `sha256:...` patch proof. Exit 0 is report-ready `SCOPE_VERIFIED`; exit 2 is a valid
incomplete, human-gated or bounded-stop route; exit 3 is a candidate mismatch; exit 1
is an invalid record. Inspection validates routing data, not the truth of its evidence.

`config.json` reuses the established result/capacity/review schema: workers start
paused with agents.maxDevelopmentSubagents=2 and require separate runtime authority to activate.
Changing the limit cannot create approval. Existing local config modifications stop
upgrade for review. Provider configuration remains isolated to the worker.

CLI exits: 0 successful command/valid record; 1 invalid or failed; 2 blocked/incomplete;
3 source/target conflict for reviewed actions. Functional outcome and lifecycle are
separate: PATCH_READY_UNVERIFIED is not accepted scope. Result success requires actual
native observation and independent lead proofs for all criteria and the complete intent.
Installer `plan` uses the release containing the invoked installer, verifies every
manifest entry, and stores release/adapter/target identities in
`.governance-artifacts/install/plan.json`. Human output contains paths and actions, not
raw hashes. The artifacts directory is ignored after installation; do not add its
first-install contents to Git. `apply --target PROJECT` recomputes and consumes that exact pending plan;
changed inputs or target state refuse. Integration-only release-location and external-pin
options remain hidden from normal help; byte identity never substitutes for publisher
trust or review.

`scope create --request docs/features/NAME/request.md --design
docs/features/NAME/design.md --output .governance-artifacts/NAME.scope.json` requires two
accepted, tracked, unchanged Markdown documents at `HEAD`. It validates their fixed
sections, matching slug and request revision, Mermaid design diagrams, stable decision
IDs and acceptance criteria; captures the current Git branch/commit; and writes an ignored
scope-v2 contract. Normal create/validate output contains readable status and revision
counts, not raw commit or scope identifiers. Version-1 scope JSON is historical input and
is rejected by active commands.

Installer exits 2 for a refusal and retains uncertain state.

The tested host uses Node24.14.0/Python3.12.3/Git2.43.0 and Codex0.149.1. The optional worker
requires Linux bubblewrap, native pidfd support, strict config and Responses API support.
It also requires an explicit secret-free worker config and the credential environment
variable named by that config. Unsupported provider/host capability stays unavailable;
there is no automatic upgrade, fallback or Desktop mutation.
