import assert from "node:assert/strict";
import { digest, validateScope } from "./scope.mjs";

import { inspectDelivery } from "./delivery.mjs";
export class GovernanceError extends Error {
  constructor(code, reason) { super(reason); this.code = code; this.reason = reason; }
}
export const fail = (code, reason) => { throw new GovernanceError(code, reason); };
export const requireState = (ok, code, reason) => { if (!ok) fail(code, reason); };
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const number = value => assert.ok(Number.isSafeInteger(value) && value > 0);
const ids = values => { assert.ok(Array.isArray(values)); values.forEach(number); assert.equal(new Set(values).size, values.length); };
const text = (value, max) => assert.ok(typeof value === "string" && value.trim() && value.length <= max);
export const payloadDigest = request => digest(Object.fromEntries(Object.entries(request).filter(([key]) => key !== "authority")));

export function validateRequest(request, scope, templates, delivery) {
  validateScope(scope); inspectDelivery(delivery);
  keys(request, ["version", "kind", "operation", "target", "payload", "dependencies", "reviewedDuplicates", "authority"]);
  assert.equal(request.version, 1); assert.ok(["issue", "pr", "worktree"].includes(request.kind));
  assert.ok(["create", "update"].includes(request.operation));
  keys(request.target, ["number", "parent", "issue"]); number(request.target.parent);
  if (request.operation === "create") assert.equal(request.target.number, null); else number(request.target.number);
  if (request.kind === "issue") assert.equal(request.target.issue, null); else number(request.target.issue);
  ids(request.dependencies); ids(request.reviewedDuplicates);
  const scopeIssue = Number(/\bissue:(\d+)\b/u.exec(scope.intentSource)?.[1]);
  assert.equal(scopeIssue, request.kind === "issue" ? request.target.number ?? request.target.parent : request.target.issue);
  if (request.kind === "worktree") {
    assert.equal(request.operation, "create"); keys(request.payload, ["name", "branch"]);
    assert.match(request.payload.name, /^[a-z0-9][a-z0-9-]{0,79}$/u);
    assert.match(request.payload.branch, new RegExp(`^(?:${delivery.project.branchPrefixes.join("|")})/${request.target.issue}-[a-z0-9][a-z0-9-]*$`, "u"));
  } else {
    const { title, body, labels, milestone } = request.payload;
    keys(request.payload, ["title", "body", "labels", "milestone"]); text(title, 200); text(body, 60000);
    assert.ok(!/[\r\n]/u.test(title)); assert.ok(Array.isArray(labels)); assert.equal(new Set(labels).size, labels.length);
    labels.forEach(label => assert.match(label, /^[a-z0-9][a-z0-9:_-]{0,79}$/u));
    if (milestone !== null) number(milestone);
    for (const heading of templates[request.kind].match(/^## .+$/gmu) ?? []) assert.ok(body.includes(heading), `Missing template heading`);
    assert.ok(/rollback/iu.test(body)); assert.ok(body.includes(`#${request.target.parent}`));
    assert.doesNotMatch(`${title}\n${body}`, /(?:\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|postgres(?:ql)?:\/\/\S+@)/u);
    if (request.kind === "issue") {
      for (const prefix of ["type:", "priority:", "status:", "area:"]) assert.ok(labels.some(label => label.startsWith(prefix)));
      for (const prefix of ["priority:", "status:"]) assert.equal(labels.filter(label => label.startsWith(prefix)).length, 1);
      assert.ok(/^- \[[ x]\] \S/mu.test(body)); assert.ok(body.split("\n").some(line => line.trim() === `Target branch: ${delivery.baseBranch}`));
    } else {
      assert.match(title, /^(?:feat|fix|chore|docs|refactor|test|ci)(?:\([a-z0-9-]+\))?: /u);
      assert.ok(new RegExp(`\\bCloses #${request.target.issue}\\b`, "u").test(body));
    }
  }
  if (request.authority !== null) {
    keys(request.authority, ["source", "reference", "scopeDigest", "payloadDigest"]);
    assert.ok(["direct-user", "authenticated-maintainer"].includes(request.authority.source));
    assert.match(request.authority.reference, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(request.authority.scopeDigest, digest(scope)); assert.equal(request.authority.payloadDigest, payloadDigest(request));
  }
  return request;
}

export function makePlan(request, scope, snapshot, templates, delivery) {
  validateRequest(request, scope, templates, delivery);
  requireState(snapshot.local.repository === delivery.project.repository, 3, "repository-conflict");
  requireState(snapshot.local.clean && snapshot.local.scopeAncestor && snapshot.local.ref === scope.source.ref, 3, "source-conflict");
  requireState(snapshot.actor.canWrite, 2, "actor-cannot-write");
  requireState(snapshot.context.parentOpen && snapshot.context.queueLinked && snapshot.context.issueOpen, 2, "task-context-incomplete");
  requireState(snapshot.context.dependenciesClosed, 2, "dependency-open");
  requireState(snapshot.context.labelsValid && snapshot.context.milestoneValid, 1, "metadata-invalid");
  requireState(snapshot.context.duplicates.every(id => request.reviewedDuplicates.includes(id)), 2, "duplicate-review-required");
  requireState(snapshot.context.targetValid, 3, "target-conflict");
  const plan = { version: 1, kind: request.kind, operation: request.operation, target: request.target,
    requestDigest: digest(request), scopeDigest: digest(scope), deliveryDigest: digest(delivery), snapshot,
    readiness: snapshot.context.codeReview?.ready === true ? "code-record-validated; other-gates-remain" : "review-incomplete-or-not-assessed",
    authority: request.authority === null ? "missing" : "caller-must-verify-original-authority",
    next: request.authority === null ? "record-verified-authority-and-replan" : "review-input-file-and-plan-before-explicit-apply" };
  return { ...plan, planDigest: digest(plan) };
}

export function validatePlan(plan, request, scope, current, templates, delivery) {
  const { planDigest, ...unsigned } = plan;
  requireState(digest(unsigned) === planDigest, 1, "plan-invalid");
  const fresh = makePlan(request, scope, current, templates, delivery);
  requireState(fresh.planDigest === plan.planDigest, 3, "stale-plan");
  requireState(request.authority !== null, 2, "authority-missing");
  return fresh;
}
