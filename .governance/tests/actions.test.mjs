import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../core/scope.mjs";
import { makePlan, validatePlan, validateRequest, payloadDigest } from "../core/plan.mjs";
import { adapter, applyPlan, context, git, github, localSnapshot, projectFile, receiptFile, withApplyLock } from "../core/actions.mjs";
import { scopeFixture } from './fixtures.mjs';


const root = fileURLToPath(new URL("..", import.meta.url));
const repository = 'ExampleOrg/sample';
const delivery = { schemaVersion: 1, project: { schemaVersion: 1, repository, branchPrefixes: ['chore','fix','feature'] }, baseBranch: 'develop', queue: null, instructionPaths: ['AGENTS.md'], templates: { issue: '.governance/templates/issue.md', pr: '.governance/templates/pr.md' } };
const sha = "a".repeat(40), templates = { issue: "## Summary\n## Acceptance", pr: "## Summary\n## Testing" };
const clone = value => structuredClone(value);
function fixture(kind = "issue", operation = "create") {
  const scope = scopeFixture({ intent: 'Deliver reviewed repository action',
    intentSource: `issue:${kind === 'issue' ? operation === 'update' ? 507 : 467 : 507}`,
    boundaries: 'Governance only.', ref: 'chore/507-actions', sourceSha: sha,
    criteria: [{ id: 'ACTION', outcome: 'Reviewed action safely applied', method: 'Focused action proof' }] });
  const request = { version: 1, kind, operation, target: { number: operation === "update" ? 507 : null, parent: 467, issue: kind === "issue" ? null : 507 },
    payload: kind === "worktree" ? { name: "child", branch: "chore/507-child" } : { title: "chore: reviewed action", body: `${templates[kind]}\nParent #467. Closes #507\nTarget branch: develop\n- [ ] Acceptance\nRollback: revert`, labels: ["type:chore", "priority:p2", "status:in-progress", "area:devops"], milestone: null }, dependencies: [506], reviewedDuplicates: [], authority: null };
  const snapshot = { local: { repository, baseBranch: "develop", deliveryDigest: digest(delivery), ref: scope.source.ref, head: sha, clean: true, scopeAncestor: true, rootDigest: digest(root), configDigest: digest({}), instructionsDigest: digest([]) }, actor: { login: "maintainer", canWrite: true },
    context: { parentOpen: true, queueLinked: true, issueOpen: true, dependenciesClosed: true, labelsValid: true, milestoneValid: true, duplicates: [], targetValid: true, staging: sha, recordsDigest: digest([]), targetDigest: null, beforeMetadata: null } };
  const authorize = () => { request.authority = { source: "direct-user", reference: `sha256:${"b".repeat(64)}`, scopeDigest: digest(scope), payloadDigest: payloadDigest(request) }; };
  authorize(); return { scope, request, snapshot, authorize };
}
const rejected = (fn, reason) => assert.throws(fn, error => error.reason === reason);
function harness(kind = "issue", operation = "create") {
  const x = fixture(kind, operation); let receipt = null, record = null;
  const counts = { core: 0, metadata: 0, prepare: 0 };
  const plan = makePlan(x.request, x.scope, clone(x.snapshot), templates, delivery);
  const io = { snapshot: () => clone(x.snapshot), read: () => clone(record), find: () => record?.number ?? null,
    writeCore() { counts.core++; record = { number: 507, state: "open", title: x.request.payload.title, body: `${x.request.payload.body}\n\n<!-- governance-plan-${plan.planDigest} -->`, labels: kind === "pr" ? [] : x.request.payload.labels, milestone: null,
      ...(kind === "pr" ? { head: { sha, ref: x.scope.source.ref, repo: { full_name: repository } }, base: { ref: "develop" } } : {}) }; return 507; },
    writeMetadata() { counts.metadata++; record.labels = x.request.payload.labels; },
    prepare() { counts.prepare++; record = { head: sha, ref: x.request.payload.branch }; }, worktree: () => clone(record) };
  const receipts = { read: () => clone(receipt), write: value => { receipt = clone(value); } };
  const run = () => applyPlan({ ...x, plan, templates, delivery, adapter: io, receipt: receipts });
  return { ...x, plan, io, receipts, counts, run, get record() { return record; }, set record(value) { record = value; } };
}
test("plans bind intent, payload, source, config, instructions and authority without printing payloads", () => {
  for (const kind of ["issue", "pr", "worktree"]) {
    const x = fixture(kind), plan = makePlan(x.request, x.scope, x.snapshot, templates, delivery);
    assert.deepEqual(makePlan(x.request, x.scope, x.snapshot, templates, delivery), plan);
    assert.equal(JSON.stringify(plan).includes(x.request.payload.body ?? "PRIVATE"), false);
    assert.equal(validatePlan(plan, x.request, x.scope, x.snapshot, templates, delivery).planDigest, plan.planDigest);
    for (const field of ["head", "configDigest", "instructionsDigest"]) {
      const changed = clone(x.snapshot); changed.local[field] = "different";
      rejected(() => validatePlan(plan, x.request, x.scope, changed, templates, delivery), "stale-plan");
    }
    x.request.authority = null; const missing = makePlan(x.request, x.scope, x.snapshot, templates, delivery);
    assert.equal(missing.authority, "missing"); rejected(() => validatePlan(missing, x.request, x.scope, x.snapshot, templates, delivery), "authority-missing");
  }
});
test("standards, scope and live preconditions reject missing or incompatible plans", () => {
  for (const change of [x => x.request.version = 9, x => x.request.payload.body = "incomplete", x => x.request.payload.labels = [], x => x.request.payload.milestone = -1,
    x => x.request.payload.title = "secret\nline", x => x.request.payload.body += "\npostgresql:" + "//private:secret@host/db", x => x.request.target.parent = 0,
    x => x.request.dependencies = [506, 506], x => x.request.authority.reference = "unverified", x => x.scope.intent = "", x => x.request.extra = true,
    x => x.request.authority.payloadDigest = "wrong", x => x.scope.intentSource = "issue:999"]) {
    const x = fixture(); change(x); assert.throws(() => validateRequest(x.request, x.scope, templates, delivery));
  }
  const cases = [["local", "clean", false, "source-conflict"], ["local", "scopeAncestor", false, "source-conflict"], ["local", "repository", "other", "repository-conflict"],
    ["actor", "canWrite", false, "actor-cannot-write"], ["context", "parentOpen", false, "task-context-incomplete"], ["context", "dependenciesClosed", false, "dependency-open"],
    ["context", "labelsValid", false, "metadata-invalid"], ["context", "duplicates", [888], "duplicate-review-required"], ["context", "targetValid", false, "target-conflict"]];
  for (const [group, field, value, reason] of cases) { const x = fixture(); x.snapshot[group][field] = value; rejected(() => makePlan(x.request, x.scope, x.snapshot, templates, delivery), reason); }
});
test("create/update exact readback and completed reruns never repeat a GitHub write", () => {
  for (const kind of ["issue", "pr"]) for (const operation of ["create", "update"]) {
    const x = harness(kind, operation); assert.equal(x.run().state, "applied"); assert.equal(x.run().state, "already-applied"); assert.equal(x.counts.core, 1);
    x.record.state = "closed"; rejected(x.run, "target-readback-conflict"); assert.equal(x.counts.core, 1);
  }
});
test("ambiguous writes reconcile effects, block absent outcomes, and reject external changes", () => {
  const absent = harness(); absent.io.writeCore = () => { throw Error("PRIVATE"); };
  rejected(absent.run, "write-outcome-unknown"); rejected(absent.run, "write-outcome-unknown");
  const changed = harness(), write = changed.io.writeCore;
  changed.io.writeCore = () => { write(); throw Error("network lost"); };
  rejected(changed.run, "write-outcome-unknown"); assert.equal(changed.run().state, "already-applied"); assert.equal(changed.counts.core, 1);
  changed.record.body = "external update"; rejected(changed.run, "target-readback-conflict");
  const stale = harness(); stale.snapshot.local.head = "c".repeat(40); rejected(stale.run, "stale-plan"); assert.equal(stale.counts.core, 0);
  const foreign = harness(); foreign.receipts.write({ version: 1, planDigest: "other" }); rejected(foreign.run, "receipt-conflict");
  const invalid = harness(); invalid.plan.planDigest = "tampered"; rejected(invalid.run, "plan-invalid");
});
test("partial PR metadata resumes only matching state and does not recreate a PR", () => {
  for (const operation of ["create", "update"]) {
    const x = harness("pr", operation), write = x.io.writeMetadata;
    x.io.writeMetadata = () => { throw Error("unknown"); }; rejected(x.run, "write-outcome-unknown");
    x.io.writeMetadata = write; assert.equal(x.run().state, "applied"); assert.equal(x.counts.core, 1); assert.equal(x.counts.metadata, 1);
  }
  const x = harness("pr"); x.io.writeMetadata = () => { x.record.labels = ["external"]; throw Error("unknown"); };
  rejected(x.run, "write-outcome-unknown"); rejected(x.run, "metadata-readback-conflict");
});
test("worktree receipts preserve uncertain creation without destructive retry", () => {
  const x = harness("worktree"); assert.equal(x.run().state, "applied"); assert.equal(x.run().state, "already-applied"); assert.equal(x.counts.prepare, 1);
  x.record = null; rejected(x.run, "worktree-outcome-unknown");
  const lost = harness("worktree"); lost.io.prepare = () => { throw Error("unknown"); }; rejected(lost.run, "worktree-outcome-unknown"); rejected(lost.run, "worktree-outcome-unknown");
  const wrong = harness("worktree"); wrong.io.prepare = () => { wrong.record = { head: "wrong", ref: wrong.request.payload.branch }; }; rejected(wrong.run, "worktree-readback-mismatch");
});
function temporaryRepo() {
  mkdirSync(join(root, ".governance-artifacts"), { recursive: true });
  const cwd = mkdtempSync(join(root, ".governance-artifacts/t1b-"));
  git(cwd, "init", "--initial-branch=chore/507-actions"); git(cwd, "remote", "add", "origin", `https://github.com/${repository}.git`);
  const files = { 'AGENTS.md': 'fixture policy', '.governance/policy.md': 'fixture governance policy', '.governance/quality.md': 'first quality policy', '.governance/principles.md': 'fixture principles', '.governance/templates/issue.md': templates.issue, '.governance/templates/pr.md': templates.pr, '.governance/config.json': readFileSync(join(root, 'config.json'), 'utf8'), '.gitignore': '.governance-artifacts/\n.worktrees/\n' };
  for (const [path, contents] of Object.entries(files)) { mkdirSync(join(cwd, path, ".."), { recursive: true }); writeFileSync(join(cwd, path), contents); }
  git(cwd, "add", "."); git(cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=worker@example.test", "commit", "-m", "fixture");
  mkdirSync(join(cwd, ".governance-artifacts")); return cwd;
}
function fakeApi(head) {
  const records = new Map(); let next = 800;
  return (path, data) => {
    if (path === "user") return { login: "maintainer" };
    if (path === `repos/${repository}`) return { full_name: repository, permissions: { push: true } };
    if (path.includes("git/ref/heads/")) return { object: { sha: head } };
    if (path.includes("labels?")) return fixture().request.payload.labels.map(name => ({ name }));
    if (path.includes("milestones?")) return [];
    if (path.startsWith("search/")) return { incomplete_results: false, total_count: 0, items: [] };
    if (path.includes("pulls?")) return [];
    const id = Number(path.split("/").at(-1));
    if (data) {
      const number = Number.isSafeInteger(id) ? id : next++;
      const old = records.get(number) ?? { number, state: "open", labels: [], milestone: null };
      const result = { ...old, ...data.body, ...(data.body.head ? { head: { sha: head, ref: data.body.head, repo: { full_name: repository } }, base: { ref: data.body.base } } : {}) };
      records.set(number, result); return clone(result);
    }
    return clone(records.get(id) ?? { number: id, state: id === 506 ? "closed" : "open", body: "Parent #467", updated_at: "2026-09-14T10:00:00Z" });
  };
}
test("real Git worktree and filesystem guards preserve source; GitHub adapter uses structured exact targets", () => {
  const cwd = temporaryRepo();
  try {
    const ctx = context(cwd, delivery), head = git(cwd, "rev-parse", "HEAD"), before = git(cwd, "ls-files", "--stage"), api = fakeApi(head);
    const x = fixture("worktree"); x.scope.source.sha = head; x.authorize();
    const io = adapter(ctx, api), plan = makePlan(x.request, x.scope, io.snapshot(x.request, x.scope), ctx.templates, delivery);
    const path = join(cwd, ".governance-artifacts/plan.json"); writeFileSync(path, JSON.stringify(plan));
    const receipts = receiptFile(path), run = () => withApplyLock(path, () => applyPlan({ ...x, plan, templates: ctx.templates, delivery, adapter: io, receipt: receipts }));
    assert.equal(run().state, "applied"); assert.equal(run().state, "already-applied");
    assert.equal(git(cwd, "rev-parse", "HEAD"), head); assert.equal(git(cwd, "ls-files", "--stage"), before); assert.equal(git(cwd, "status", "--porcelain"), "");
    assert.equal(git(join(cwd, ".worktrees/child"), "rev-parse", "HEAD"), head);
    rejected(() => makePlan(x.request, x.scope, io.snapshot(x.request, x.scope), ctx.templates, delivery), "target-conflict");
    git(cwd, "worktree", "remove", join(cwd, ".worktrees/child"));
    assert.equal(projectFile(cwd, path), path); rejected(() => projectFile(cwd, root), "input-path-invalid");
    symlinkSync(path, `${path}.link`); rejected(() => projectFile(cwd, `${path}.link`), "input-path-invalid");
    rejected(() => withApplyLock(path, () => withApplyLock(path, () => {})), "apply-in-progress-or-interrupted"); assert.equal(existsSync(`${path}.lock`), false);
    for (const kind of ["issue", "pr"]) {
      const action = fixture(kind); action.scope.source.sha = head; action.authorize();
      const snapshot = io.snapshot(action.request, action.scope), p = makePlan(action.request, action.scope, snapshot, templates, delivery);
      let r = null; const receipt = { read: () => r, write: value => { r = value; } };
      const args = { ...action, plan: p, templates, delivery, adapter: io, receipt };
      assert.equal(applyPlan(args).state, "applied"); assert.equal(applyPlan(args).state, "already-applied");
    }
    assert.equal(git(cwd, "status", "--porcelain"), "");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("packaged instruction paths bind quality-policy changes into action snapshots", () => {
  const cwd = temporaryRepo();
  try {
    const packaged = JSON.parse(readFileSync(join(root, 'examples/adapter.json'), 'utf8')).delivery;
    const configured = { ...packaged, project: delivery.project };
    const ctx = context(cwd, configured), before = localSnapshot(ctx, fixture().scope);
    writeFileSync(join(cwd, '.governance/quality.md'), 'changed quality policy');
    const after = localSnapshot(ctx, fixture().scope);
    assert.notEqual(after.instructionsDigest, before.instructionsDigest);
    assert.equal(after.clean, false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("GitHub transport supports installed pagination and sanitizes failures", () => {
  const execute = (program, args, options) => {
    assert.equal(program, "gh"); assert.deepEqual(args.slice(-3), ["--paginate", "--jq", ".[] | @json"]); assert.equal(options.timeout, 30000);
    return '{"name":"first"}\n{"name":"second"}\n';
  };
  assert.deepEqual(github("labels", undefined, true, execute), [{ name: "first" }, { name: "second" }]);
  assert.deepEqual(github("labels", undefined, true, () => ""), []);
  assert.equal(github("issues", { method: "POST", body: { title: "reviewed" } }, false, (program, args, options) => {
    assert.deepEqual(args, ["api", "--hostname", "github.com", "issues", "--method", "POST", "--input", "-"]); assert.deepEqual(JSON.parse(options.input), { title: "reviewed" }); return '{"number":507}';
  }).number, 507);
  rejected(() => github("issues", undefined, false, () => { throw Error("PRIVATE"); }), "github-state-unavailable");
});
