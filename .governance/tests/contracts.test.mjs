import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, validateScope } from '../core/scope.mjs';
import { inspectProject } from '../core/project.mjs';
import { inspectConfig, inspectResult, inspectLegacy } from '../core/contracts.mjs';
import { scopeFixture } from './fixtures.mjs';

const sha = 'a'.repeat(40), proof = `sha256:${'b'.repeat(64)}`, at = '2026-09-15T07:00:00Z';
// Adapted from the original synthetic contract fixture; no runtime/proof claim.
function fixture(repository = 'example/alpha', prefix = 'chore') {
  const project = { schemaVersion: 1, repository, branchPrefixes: [prefix] };
  const source = { repository, worktree: '/project/.worktrees/task', ref: `${prefix}/task`, sha };
  const scope = scopeFixture({ intent: 'Deliver the recorded scope', ref: source.ref, sourceSha: sha,
    boundaries: 'Synthetic contract only.', criteria: [{ id: 'A', outcome: 'Complete A', method: 'Focused proof' }] });
  const assignment = { id: 'assignment-1', attemptId: 'attempt-1', scopeDigest: digest(scope), scopeRevision: 1, source, runtimeId: 'process-123-start-456' };
  const result = { schemaVersion: 2, assignmentId: assignment.id, attemptId: assignment.attemptId, scopeDigest: digest(scope), scopeRevision: 1,
    source: { ...source, dirty: true, patchProof: proof }, completed: [{ id: 'A', proof }], remaining: [], defects: [], verification: 'passed', blocked: false, executionFailed: false, reportedOutcome: 'SCOPE_VERIFIED' };
  const observation = { assignmentId: assignment.id, attemptId: assignment.attemptId, runtimeId: assignment.runtimeId, state: 'TERMINATED', observedAt: at, proof, completedAt: at, stop: null };
  const leadReview = { scopeDigest: digest(scope), scopeRevision: 1, sourceDigest: digest(result.source), criteria: [{ id: 'A', proof }], intentProof: proof, reviewedAt: at };
  return { project, scope, assignment, result, observation, leadReview, currentHead: sha };
}

test('same contract works for two explicit repository and branch adapters', () => {
  for (const x of [fixture(), fixture('example/beta', 'task')]) {
    const result = inspectResult(x);
    assert.deepEqual([result.validation, result.outcome, result.outcomeCode, result.acceptedScope], ['VALID', 'SCOPE_VERIFIED', 0, true]);
  }
});

test('foreign repository and branch cannot pass the selected adapter', () => {
  const x = fixture();
  x.project.repository = 'example/beta';
  assert.equal(inspectResult(x).validation, 'INVALID_RESULT');
  x.project.repository = 'example/alpha'; x.project.branchPrefixes = ['task'];
  assert.equal(inspectResult(x).acceptedScope, false);
  assert.throws(() => inspectResult({ ...fixture(), project: undefined }));
});

test('adapter schema rejects unknown fields, invalid identity and unsafe prefixes', () => {
  for (const edit of [{ schemaVersion: 2 }, { extra: true }, { repository: '../outside' }, { branchPrefixes: [] },
    { branchPrefixes: ['../task'] }, { branchPrefixes: ['task', 'task'] }]) {
    assert.throws(() => inspectProject({ ...fixture().project, ...edit }));
  }
});

test('scope-v2 intent, documents and every criterion remain required before work', () => {
  for (const edit of [{ version: 1 }, { intent: '' }, { documents: null }, { criteria: [] }, { criteria: [{ id: 'A', outcome: 'A' }] }]) {
    const x = fixture(); Object.assign(x.scope, edit);
    assert.throws(() => validateScope(x.scope));
    assert.equal(inspectResult(x).acceptedScope, false);
  }
});

test('worker assertion cannot replace runtime and independent criterion/intent proof', () => {
  for (const change of [x => x.leadReview = null, x => x.observation = null,
    x => x.observation.state = 'UNKNOWN', x => x.leadReview.criteria = [],
    x => x.leadReview.intentProof = null, x => x.currentHead = 'c'.repeat(40)]) {
    const x = fixture(); change(x);
    assert.equal(inspectResult(x).acceptedScope, false);
  }
});

test('functional failure and legacy exit zero stay distinct from accepted success', () => {
  const x = fixture(); x.result.defects = ['D-1']; x.result.reportedOutcome = 'DEFECTS_UNRESOLVED';
  const result = inspectResult(x);
  assert.deepEqual([result.validation, result.outcome, result.outcomeCode, result.acceptedScope], ['VALID', 'DEFECTS_UNRESOLVED', 31, false]);
  assert.equal(inspectLegacy({ schema_version: 1, code: 0, base: sha, lifecycle: 'TERMINATED' }).acceptedScope, false);
});

test('default capacity is disabled/two; increasing a setting grants no activation', () => {
  const config = { schemaVersion: 1, agents: { enabled: false, maxDevelopmentSubagents: 2 } };
  const paused = inspectConfig(config);
  assert.deepEqual([paused.configured, paused.effective, paused.state], [2, 0, 'paused']);
  config.agents = { enabled: true, maxDevelopmentSubagents: 4 };
  assert.deepEqual([inspectConfig(config).effective, inspectConfig(config).state], [0, 'blocked']);
  assert.equal(inspectConfig(config, { configDigest: digest(config), source: sha, authorityProof: proof, approved: 2, runtime: 3, budget: 4 }).effective, 2);
});
