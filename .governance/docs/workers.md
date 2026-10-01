# Optional bounded worker

Default route: lead → tools/delegate-worker → separate Codex exec → explicitly configured
Responses-compatible provider/model → isolated Git worktree → patch → lead review/test →
apply/reject. The package does not select a provider or model and permits no fallback.
Copy `.governance/worker/worker.config.toml.example` to a private ignored location, set one custom
provider and model, then pass it with `--worker-config`. The configuration names its
credential environment variable but contains no credential. An explicitly supplied env
file may load only that variable. Never create a plaintext secret file in this kit.

Only enable under actual scoped user/maintainer approval. The primary Git checkout owns
`.codex/delegations/` (0700), one shared capacity pool for all linked worktrees.
`python3 .governance/worker/worker.py install` prepares that ignored directory only.
It does not activate a provider or modify user configuration. Preserve old receipts and
reconcile every pending result before dispatch. A different canonical runner blocks dispatch.
Tool/source/config changes
invalidate previous activation. The installer does not propagate into sibling worktrees.

Prepare private `authority.json` and `activation.json` (0600) only from verified authority.
Activation has version,id,toolSource,toolDigest,configDigest,approved,expiresAt,maxSeconds,
maxAttempts,authority,tasks. `authority` hashes the actual private authority record;
`toolSource` is the tool checkout HEAD and `toolDigest` comes from `worker/dispatch.py`.
Each task binds id,scopeDigest,scopes,leadWorktree,sourceSha,workerRef. Scope.source.ref is
an unused approved worker branch; source.sha is the lead's exact clean commit. Its
committed `.governance/project.json` supplies repository identity and permitted prefixes.
Use the actual implementation for serialization and validation; hashes alone are never approval.
The primary `config.json` must be enabled within the approved runtime bound. Capacity is
the minimum of configured, approved, runtime and remaining calls. Up to three corrections
after attempt 1 are supported; the task ID and worker ref keep their attempt sequence
across new activation records. Wall time and call limits remain explicit. No automatic retry.

```sh
tools/delegate-worker --worker-config .governance-artifacts/worker.toml --scope-record .governance-artifacts/scope.json --task-id bounded-fix --scope 'src/example.ts' --attempt 1 --timeout 600 -- 'Implement the recorded scope; return criterion proof and remaining defects.'
```

This command requires the records above; it is not an activation example to run blindly.
Read the result, complete diff and actual native termination. Exit0 means patch ready,
not accepted. Apply explicitly with `tools/apply-worker-patch PATH`, then independently
run relevant tests and verify each criterion and complete intent. Record source-bound
lead acceptance and patch disposition. Failed/unverified/blocked scopes stay non-success.
Unknown ownership preserves the worktree and blocks new conflicting work.

The result validator retains enumerated workload and lifecycle states. Functional exits
30/31/32/33 mean verification failed/defects unresolved/blocked/verification incomplete;
22/23/24/25 are execution failure/bounds/cancelled/cleanup uncertainty. Never confuse process
exit with functional acceptance. Logs retain sanitized diagnostics and explicit usage,
not raw model/shell text, secrets or private imports. Git metadata is masked in the worker.
