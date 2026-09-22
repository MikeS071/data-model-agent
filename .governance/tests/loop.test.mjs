import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectLoop } from '../core/loop.mjs';
import { digest } from '../core/scope.mjs';
import { scopeFixture } from './fixtures.mjs';

const sha = 'a'.repeat(40), nextSha = 'b'.repeat(40), proof = `sha256:${'c'.repeat(64)}`;
const startedAt = '2026-09-22T08:00:00Z', recordedAt = '2026-09-22T08:05:00Z';
const scope = scopeFixture({ sourceSha: sha, criteria: [
    { id: 'A', outcome: 'Complete A', method: 'Focused test' },
    { id: 'B', outcome: 'Complete B', method: 'Artifact inspection' },
  ] });
const policy = { schemaVersion: 1, maxIterations: 3, maxSameFailure: 2, maxElapsedMinutes: 60 };
const evidence = (criterionId, kind = 'test') => ({ criterionId, kind, proof });
const candidate = (value = sha, patchProof = proof, ref = 'feature/task') => ({ ref, sha: value, patchProof });
const iteration = (number, outcome, overrides = {}) => ({
  number, candidate: candidate(), outcome, criteria: ['A'], evidence: [evidence('A')],
  failureKey: outcome === 'SCOPE_VERIFIED' ? null : 'A:ASSERTION',
  intentProof: outcome === 'SCOPE_VERIFIED' ? proof : null, recordedAt, ...overrides,
});
const record = (iterations = [], overrides = {}) => ({
  schemaVersion: 1, scopeDigest: digest(scope), scopeRevision: 1, startedAt,
  observedAt: '2026-09-22T08:10:00Z', iterations, ...overrides,
});
const inspect = (ledger, currentHead = ledger.iterations.at(-1)?.candidate.sha ?? sha,
  currentPatchProof = ledger.iterations.at(-1)?.candidate.patchProof ?? null) =>
  inspectLoop({ scope, policy, record: ledger, currentRef: 'feature/task', currentHead, currentPatchProof });

test('a new run routes to build without claiming accepted scope', () => {
  const result = inspect(record());
  assert.deepEqual([result.validation, result.outcome, result.route, result.acceptedScope, result.code],
    ['VALID', 'INCOMPLETE', 'build', false, 2]);
  assert.deepEqual([result.iteration, result.remainingIterations], [0, 3]);
});

test('an implementation defect loops to build and changed source can verify every criterion', () => {
  const failed = iteration(1, 'IMPLEMENTATION_DEFECT');
  assert.deepEqual([inspect(record([failed])).route, inspect(record([failed])).repeatedFailureCount], ['build', 1]);
  const verified = iteration(2, 'SCOPE_VERIFIED', {
    candidate: candidate(nextSha, null), criteria: ['A', 'B'],
    evidence: [evidence('A'), evidence('B', 'inspection')], failureKey: null, intentProof: proof,
    recordedAt: '2026-09-22T08:09:00Z',
  });
  const result = inspect(record([failed, verified]), nextSha, null);
  assert.deepEqual([result.validation, result.outcome, result.route, result.acceptedScope, result.code],
    ['VALID', 'SCOPE_VERIFIED', 'report', true, 0]);
});

test('scope, oracle and environment failures route to distinct owners', () => {
  for (const [outcome, route] of [
    ['SCOPE_GAP', 'human-design-review'],
    ['TEST_ORACLE_INVALID', 'human-acceptance-review'],
    ['ENVIRONMENT_FAILED', 'repair-environment'],
    ['BLOCKED', 'human-input'],
  ]) assert.equal(inspect(record([iteration(1, outcome)])).route, route);
});

test('same failure and iteration or elapsed budgets stop an unproductive loop', () => {
  const first = iteration(1, 'ENVIRONMENT_FAILED');
  const second = iteration(2, 'ENVIRONMENT_FAILED', { recordedAt: '2026-09-22T08:06:00Z' });
  assert.deepEqual([inspect(record([first, second])).route, inspect(record([first, second])).stopReason],
    ['human-review', 'same-failure-limit']);
  const third = iteration(3, 'ENVIRONMENT_FAILED', {
    failureKey: 'ENV:THIRD', recordedAt: '2026-09-22T08:07:00Z',
  });
  assert.equal(inspect(record([first, { ...second, failureKey: 'ENV:SECOND' }, third])).stopReason, 'iteration-limit');
  assert.equal(inspect(record([first], { observedAt: '2026-09-22T09:00:00Z' })).stopReason, 'elapsed-limit');
});

test('invalid evidence, unchanged implementation source and post-terminal entries are rejected', () => {
  const badVerified = iteration(1, 'SCOPE_VERIFIED', { failureKey: null, intentProof: proof });
  assert.equal(inspect(record([badVerified])).validation, 'INVALID_RECORD');
  const unchanged = iteration(2, 'SCOPE_VERIFIED', {
    criteria: ['A', 'B'], evidence: [evidence('A'), evidence('B')], failureKey: null, intentProof: proof,
    recordedAt: '2026-09-22T08:09:00Z',
  });
  assert.equal(inspect(record([iteration(1, 'IMPLEMENTATION_DEFECT'), unchanged])).validation, 'INVALID_RECORD');
  const gapThenWork = [iteration(1, 'SCOPE_GAP'), iteration(2, 'ENVIRONMENT_FAILED', { recordedAt: '2026-09-22T08:09:00Z' })];
  assert.equal(inspect(record(gapThenWork)).validation, 'INVALID_RECORD');
});

test('the latest ledger entry must match the independently observed candidate', () => {
  const result = inspect(record([iteration(1, 'IMPLEMENTATION_DEFECT')]), nextSha, proof);
  assert.deepEqual([result.validation, result.code, result.route], ['HEAD_MISMATCH', 3, 'reconcile-source']);
  const wrongRef = inspectLoop({ scope, policy, record: record([iteration(1, 'IMPLEMENTATION_DEFECT')]),
    currentRef: 'feature/other', currentHead: sha, currentPatchProof: proof });
  assert.equal(wrongRef.validation, 'HEAD_MISMATCH');
});
