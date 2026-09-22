import assert from 'node:assert/strict';
import { digest, validateScope } from './scope.mjs';

export const loopOutcomes = [
  'IMPLEMENTATION_DEFECT', 'SCOPE_GAP', 'TEST_ORACLE_INVALID',
  'ENVIRONMENT_FAILED', 'BLOCKED', 'SCOPE_VERIFIED',
];

const terminalOutcomes = new Set(['SCOPE_GAP', 'TEST_ORACLE_INVALID', 'BLOCKED', 'SCOPE_VERIFIED']);
const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), names.sort());
const sha = value => assert.match(value ?? '', /^[a-f0-9]{40}$/u);
const proof = value => assert.match(value ?? '', /^sha256:[a-f0-9]{64}$/u);
const time = value => {
  assert.match(value ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u);
  assert.ok(Number.isFinite(Date.parse(value)));
};
const positive = value => assert.ok(Number.isSafeInteger(value) && value > 0);
const unique = values => { assert.ok(Array.isArray(values)); assert.equal(new Set(values).size, values.length); };
const fingerprint = candidate => `${candidate.ref}:${candidate.sha}:${candidate.patchProof ?? 'clean'}`;

function inspectPolicy(policy) {
  keys(policy, ['schemaVersion', 'maxIterations', 'maxSameFailure', 'maxElapsedMinutes']);
  assert.equal(policy.schemaVersion, 1);
  positive(policy.maxIterations); positive(policy.maxSameFailure); positive(policy.maxElapsedMinutes);
}

function inspectEvidence(rows, ids) {
  assert.ok(Array.isArray(rows) && rows.length > 0);
  for (const row of rows) {
    keys(row, ['criterionId', 'kind', 'proof']);
    assert.ok(row.criterionId === null || ids.includes(row.criterionId));
    assert.ok(['test', 'inspection', 'review', 'environment'].includes(row.kind));
    proof(row.proof);
  }
}

function inspectRecord(scope, policy, record) {
  keys(record, ['schemaVersion', 'scopeDigest', 'scopeRevision', 'startedAt', 'observedAt', 'iterations']);
  assert.equal(record.schemaVersion, 1); assert.equal(record.scopeDigest, digest(scope));
  assert.equal(record.scopeRevision, scope.revision); time(record.startedAt); time(record.observedAt);
  assert.ok(Date.parse(record.observedAt) >= Date.parse(record.startedAt));
  assert.ok(Array.isArray(record.iterations) && record.iterations.length <= policy.maxIterations);
  const ids = scope.criteria.map(row => row.id);
  for (const [index, row] of record.iterations.entries()) {
    keys(row, ['number', 'candidate', 'outcome', 'criteria', 'evidence', 'failureKey', 'intentProof', 'recordedAt']);
    assert.equal(row.number, index + 1); keys(row.candidate, ['ref', 'sha', 'patchProof']);
    assert.equal(row.candidate.ref, scope.source.ref); sha(row.candidate.sha);
    if (row.candidate.patchProof !== null) proof(row.candidate.patchProof);
    assert.ok(loopOutcomes.includes(row.outcome)); unique(row.criteria);
    assert.ok(row.criteria.every(id => ids.includes(id))); inspectEvidence(row.evidence, ids);
    time(row.recordedAt); assert.ok(Date.parse(row.recordedAt) >= Date.parse(record.startedAt));
    assert.ok(Date.parse(row.recordedAt) <= Date.parse(record.observedAt));
    if (index > 0) {
      const previous = record.iterations[index - 1];
      assert.ok(Date.parse(row.recordedAt) >= Date.parse(previous.recordedAt));
      assert.ok(!terminalOutcomes.has(previous.outcome));
      if (previous.outcome === 'IMPLEMENTATION_DEFECT') assert.notEqual(fingerprint(row.candidate), fingerprint(previous.candidate));
    }
    if (row.outcome === 'SCOPE_VERIFIED') {
      assert.deepEqual([...row.criteria].sort(), [...ids].sort()); proof(row.intentProof);
      assert.equal(row.failureKey, null);
      for (const id of ids) assert.ok(row.evidence.some(item => item.criterionId === id));
    } else {
      assert.match(row.failureKey ?? '', /^[A-Z0-9][A-Z0-9_.:-]{0,159}$/u);
      assert.equal(row.intentProof, null);
    }
  }
}

function invalid(validation, code, route) {
  return { schemaVersion: 1, validation, outcome: null, route, stopReason: null,
    acceptedScope: false, iteration: null, remainingIterations: null,
    repeatedFailureCount: null, elapsedMinutes: null, code,
    authority: 'record-validation-only; human scope, acceptance, merge and release gates remain required' };
}

export function inspectLoop({ scope, policy, record, currentRef, currentHead, currentPatchProof }) {
  try {
    validateScope(scope); inspectPolicy(policy); inspectRecord(scope, policy, record);
    sha(currentHead); if (currentPatchProof !== null) proof(currentPatchProof);
  } catch { return invalid('INVALID_RECORD', 1, 'repair-record'); }

  const latest = record.iterations.at(-1) ?? null;
  const expected = latest?.candidate ?? { ref: scope.source.ref, sha: scope.source.sha, patchProof: null };
  if (expected.ref !== currentRef || expected.sha !== currentHead || expected.patchProof !== currentPatchProof) {
    return invalid('HEAD_MISMATCH', 3, 'reconcile-source');
  }

  const iteration = record.iterations.length;
  const elapsedMinutes = (Date.parse(record.observedAt) - Date.parse(record.startedAt)) / 60000;
  let repeatedFailureCount = 0;
  if (latest?.failureKey) {
    for (let index = iteration - 1; index >= 0 && record.iterations[index].failureKey === latest.failureKey; index -= 1) repeatedFailureCount += 1;
  }
  let route = 'build', stopReason = null;
  if (latest?.outcome === 'SCOPE_VERIFIED') route = 'report';
  else if (latest?.outcome === 'SCOPE_GAP') route = 'human-design-review';
  else if (latest?.outcome === 'TEST_ORACLE_INVALID') route = 'human-acceptance-review';
  else if (latest?.outcome === 'BLOCKED') route = 'human-input';
  else if (iteration >= policy.maxIterations) { route = 'stop-budget'; stopReason = 'iteration-limit'; }
  else if (elapsedMinutes >= policy.maxElapsedMinutes) { route = 'stop-budget'; stopReason = 'elapsed-limit'; }
  else if (repeatedFailureCount >= policy.maxSameFailure) { route = 'human-review'; stopReason = 'same-failure-limit'; }
  else if (latest?.outcome === 'ENVIRONMENT_FAILED') route = 'repair-environment';

  const acceptedScope = route === 'report';
  return { schemaVersion: 1, validation: 'VALID', outcome: latest?.outcome ?? 'INCOMPLETE', route, stopReason,
    acceptedScope, iteration, remainingIterations: Math.max(0, policy.maxIterations - iteration), repeatedFailureCount,
    elapsedMinutes, code: acceptedScope ? 0 : 2,
    authority: 'record-validation-only; human scope, acceptance, merge and release gates remain required' };
}
