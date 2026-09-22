import { reviewSettings } from './cost.mjs';
import assert from "node:assert/strict";
import { digest, validateScope } from "./scope.mjs";

export const lifecycleStates = ["QUEUED", "RUNNING", "STOP_REQUESTED", "TERMINATED", "UNKNOWN"];
export const outcomes = ["BUDGET_EXHAUSTED", "CANCELLED", "EXECUTION_FAILED", "DEFECTS_UNRESOLVED", "VERIFICATION_FAILED", "BLOCKED", "VERIFICATION_INCOMPLETE", "SCOPE_VERIFIED"];
export const outcomeCodes = { SCOPE_VERIFIED: 0, DEFECTS_UNRESOLVED: 31, VERIFICATION_FAILED: 30, VERIFICATION_INCOMPLETE: 33, BLOCKED: 32, EXECUTION_FAILED: 22, CANCELLED: 24, BUDGET_EXHAUSTED: 23 };
import { inspectProject } from "./project.mjs";
const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), names.sort());
const sha = value => assert.match(value ?? "", /^[a-f0-9]{40}$/u);
const hash = value => assert.match(value ?? "", /^[a-f0-9]{64}$/u);
const proof = value => assert.match(value ?? "", /^sha256:[a-f0-9]{64}$/u);
const identity = value => assert.match(value ?? "", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u);
const time = value => { assert.match(value ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u); assert.ok(Number.isFinite(Date.parse(value))); };
const count = value => assert.ok(Number.isSafeInteger(value) && value >= 0);
const boolean = value => assert.equal(typeof value, "boolean");
const includes = (value, list) => assert.ok(list.includes(value));
const unique = values => { assert.ok(Array.isArray(values)); assert.equal(new Set(values).size, values.length); };

export function inspectConfig(config, limits = null) {
  keys(config, ["schemaVersion", "agents", ...(Object.hasOwn(config, "review") ? ["review"] : [])]); assert.equal(config.schemaVersion, 1);
  reviewSettings(config);
  keys(config.agents, ["enabled", "maxDevelopmentSubagents"]);
  boolean(config.agents.enabled); count(config.agents.maxDevelopmentSubagents);
  let trustedLimits = false;
  if (limits !== null) {
    keys(limits, ["configDigest", "source", "authorityProof", "approved", "runtime", "budget"]);
    hash(limits.configDigest); sha(limits.source); proof(limits.authorityProof);
    for (const field of ["approved", "runtime", "budget"]) if (limits[field] !== null) count(limits[field]);
    trustedLimits = limits.configDigest === digest(config) && [limits.approved, limits.runtime, limits.budget].every(value => value !== null);
  }
  const enabled = config.agents.enabled && config.agents.maxDevelopmentSubagents > 0;
  return { configDigest: digest(config), configured: config.agents.maxDevelopmentSubagents, enabled: config.agents.enabled,
    approved: limits?.approved ?? null, runtime: limits?.runtime ?? null, budget: limits?.budget ?? null,
    effective: enabled && trustedLimits ? Math.min(config.agents.maxDevelopmentSubagents, limits.approved, limits.runtime, limits.budget) : 0,
    state: !enabled ? "paused" : trustedLimits ? "bounded" : "blocked",
    reason: !enabled ? "dispatch-paused" : trustedLimits ? "caller-must-enforce-observed-bounds" : "activation-or-capacity-unknown",
    dispatch: "not-implemented-here" };
}

function source(value, project, result = false) {
  keys(value, result ? ["repository", "worktree", "ref", "sha", "dirty", "patchProof"] : ["repository", "worktree", "ref", "sha"]);
  assert.equal(value.repository, project.repository); sha(value.sha);
  assert.match(value.worktree ?? "", /^\/[A-Za-z0-9_./-]+$/u); assert.ok(!value.worktree.split("/").includes(".."));
  assert.match(value.ref ?? "", /^[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_./-]*$/u);
  assert.ok(project.branchPrefixes.includes(value.ref.split("/")[0]));
  if (result) { boolean(value.dirty); if (value.dirty) proof(value.patchProof); else assert.equal(value.patchProof, null); }
}
function criteria(rows, expected) {
  unique(rows.map(row => row.id));
  for (const row of rows) { keys(row, ["id", "proof"]); includes(row.id, expected); proof(row.proof); }
}

// Caller supplies independently obtained assignment/runtime/review inputs, never worker-authored authority.
export function inspectResult({ scope, assignment, result, observation, leadReview = null, currentHead, project }) {
  inspectProject(project);
  const faults = [];
  const check = (code, action) => { try { action(); return true; } catch { faults.push(code); return false; } };
  const validScope = check("INVALID_RESULT", () => validateScope(scope));
  const ids = validScope ? scope.criteria.map(row => row.id) : [];
  check("INVALID_RESULT", () => {
    keys(assignment, ["id", "attemptId", "scopeDigest", "scopeRevision", "source", "runtimeId"]);
    identity(assignment.id); identity(assignment.attemptId); hash(assignment.scopeDigest);
    assert.equal(assignment.scopeDigest, digest(scope)); assert.equal(assignment.scopeRevision, scope.revision);
    source(assignment.source, project); if (assignment.runtimeId !== null) identity(assignment.runtimeId);
  });
  const validResult = check("INVALID_RESULT", () => {
    keys(result, ["schemaVersion", "assignmentId", "attemptId", "scopeDigest", "scopeRevision", "source", "completed", "remaining", "defects", "verification", "blocked", "executionFailed", "reportedOutcome"]);
    assert.equal(result.schemaVersion, 2); assert.equal(result.assignmentId, assignment.id); assert.equal(result.attemptId, assignment.attemptId);
    assert.equal(result.scopeDigest, digest(scope)); assert.equal(result.scopeRevision, scope.revision); source(result.source, project, true);
    criteria(result.completed, ids); unique(result.remaining); unique(result.defects); result.defects.forEach(identity);
    const partition = [...result.completed.map(row => row.id), ...result.remaining]; unique(partition); assert.deepEqual(partition.sort(), [...ids].sort());
    includes(result.verification, ["passed", "failed", "incomplete"]); boolean(result.blocked); boolean(result.executionFailed); includes(result.reportedOutcome, outcomes);
    if (result.reportedOutcome === "SCOPE_VERIFIED") assert.ok(!result.remaining.length && !result.defects.length && result.verification === "passed" && !result.blocked && !result.executionFailed);
    if (result.reportedOutcome === "DEFECTS_UNRESOLVED") assert.ok(result.defects.length);
    if (result.reportedOutcome === "VERIFICATION_FAILED") assert.equal(result.verification, "failed");
    if (result.reportedOutcome === "BLOCKED") assert.ok(result.blocked);
    if (result.reportedOutcome === "EXECUTION_FAILED") assert.ok(result.executionFailed);
  });
  const validObservation = observation !== null && observation !== undefined && check("INVALID_RESULT", () => {
    keys(observation, ["assignmentId", "attemptId", "runtimeId", "state", "observedAt", "proof", "completedAt", "stop"]);
    assert.equal(observation.assignmentId, assignment.id); assert.equal(observation.attemptId, assignment.attemptId);
    assert.equal(observation.runtimeId, assignment.runtimeId); includes(observation.state, lifecycleStates); time(observation.observedAt); proof(observation.proof);
    if (observation.completedAt !== null) { time(observation.completedAt); assert.ok(Date.parse(observation.completedAt) <= Date.parse(observation.observedAt)); }
    if (observation.state === "TERMINATED") assert.notEqual(observation.completedAt, null);
    if (observation.state === "QUEUED") { assert.equal(observation.runtimeId, null); assert.equal(observation.completedAt, null); }
    if (["RUNNING", "STOP_REQUESTED", "TERMINATED"].includes(observation.state)) identity(observation.runtimeId);
    if (observation.stop !== null) {
      keys(observation.stop, ["kind", "at", "causality", "proof"]); includes(observation.stop.kind, ["CANCELLED", "BUDGET_EXHAUSTED"]);
      includes(observation.stop.causality, ["effective", "late", "unknown"]); time(observation.stop.at); proof(observation.stop.proof);
      assert.ok(Date.parse(observation.stop.at) <= Date.parse(observation.observedAt));
      if (observation.completedAt && observation.stop.causality !== "unknown") {
        assert.ok(observation.stop.causality === "effective" ? Date.parse(observation.stop.at) < Date.parse(observation.completedAt)
          : Date.parse(observation.stop.at) > Date.parse(observation.completedAt));
      }
    }
  });
  if (validScope && assignment?.source && result?.source) check("HEAD_MISMATCH", () => {
    assert.equal(assignment.source.sha, scope.source.sha); assert.equal(assignment.source.ref, scope.source.ref);
    if (currentHead !== undefined) { sha(currentHead); assert.equal(assignment.source.sha, currentHead); }
    for (const key of ["repository", "worktree", "ref", "sha"]) assert.equal(result.source[key], assignment.source[key]);
  });
  const runtimeKnown = validObservation && observation.state !== "UNKNOWN" && observation.stop?.causality !== "unknown";
  if (!runtimeKnown) faults.push("RUNTIME_ERROR");
  let reviewed = false;
  if (leadReview !== null) reviewed = check("INVALID_RESULT", () => {
    keys(leadReview, ["scopeDigest", "scopeRevision", "sourceDigest", "criteria", "intentProof", "reviewedAt"]);
    assert.equal(leadReview.scopeDigest, digest(scope)); assert.equal(leadReview.scopeRevision, scope.revision);
    hash(leadReview.sourceDigest); criteria(leadReview.criteria, ids); assert.equal(leadReview.criteria.length, ids.length);
    proof(leadReview.intentProof); time(leadReview.reviewedAt);
    if (validObservation && observation.completedAt) assert.ok(Date.parse(leadReview.reviewedAt) >= Date.parse(observation.completedAt));
  });
  if (reviewed && validResult && !check("HEAD_MISMATCH", () => assert.equal(leadReview.sourceDigest, digest(result.source)))) reviewed = false;
  const terminal = runtimeKnown && (observation.state === "TERMINATED" || observation.state === "QUEUED" && observation.stop?.causality === "effective");
  if (validResult && ["CANCELLED", "BUDGET_EXHAUSTED"].includes(result.reportedOutcome)) check("INVALID_RESULT", () => {
    assert.ok(terminal); assert.equal(observation.stop?.kind, result.reportedOutcome); assert.equal(observation.stop?.causality, "effective");
  });
  const findings = validResult ? [
    terminal && observation.stop?.causality === "effective" ? observation.stop.kind : null,
    result.executionFailed ? "EXECUTION_FAILED" : null, result.defects.length ? "DEFECTS_UNRESOLVED" : null,
    result.verification === "failed" ? "VERIFICATION_FAILED" : null, result.blocked ? "BLOCKED" : null,
    !reviewed || result.remaining.length || result.verification !== "passed" ? "VERIFICATION_INCOMPLETE" : null,
  ].filter(Boolean) : [];
  const validation = ["INVALID_RESULT", "HEAD_MISMATCH", "RUNTIME_ERROR"].find(code => faults.includes(code)) ?? "VALID";
  const outcome = validation === "VALID" && terminal ? outcomes.find(value => findings.includes(value)) ?? "SCOPE_VERIFIED" : null;
  return { schemaVersion: 2, validation, outcomeCode: outcome === null ? null : outcomeCodes[outcome], lifecycle: validObservation ? observation.state : "UNKNOWN", outcome,
    findings: outcomes.filter(value => findings.includes(value)), faults: [...new Set(faults)],
    scopeDigest: validScope ? digest(scope) : null, scopeRevision: validScope ? scope.revision : null,
    acceptedScope: outcome === "SCOPE_VERIFIED", sourceDigest: validResult ? digest(result.source) : null,
    code: validation === "INVALID_RESULT" ? 1 : validation === "HEAD_MISMATCH" ? 3 : validation === "RUNTIME_ERROR" || !terminal ? 2 : 0,
    authority: "record-validation-only; caller verifies runtime and independent lead proof; never merge authority" };
}

export function inspectLegacy(record) {
  // Existing v1 receipts lack scope/attempt/observation proof. Preserve that gap, not a synthetic upgrade.
  assert.equal(record.schema_version, 1); count(record.code); sha(record.base); includes(record.lifecycle, lifecycleStates);
  return { schemaVersion: 1, legacyCode: record.code, reportedLifecycle: record.lifecycle,
    validation: "INVALID_RESULT", outcome: "VERIFICATION_INCOMPLETE", outcomeCode: outcomeCodes.VERIFICATION_INCOMPLETE, acceptedScope: false, code: 2,
    reason: "legacy-receipt-missing-scope-and-independent-runtime-proof" };
}
