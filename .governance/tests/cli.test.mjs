import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { digest } from '../core/scope.mjs';
import { designDocument, requestDocument, scopeFixture } from './fixtures.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url))), cli = join(root, 'dev-stack.mjs');
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined },
});

test('actual default config inspection is paused/two and preserves the artifact', () => {
  const before = readFileSync(join(root, 'config.json'));
  const result = run(root, 'config', 'validate', '--config', 'config.json');
  assert.equal(result.status, 0);
  const body = JSON.parse(result.stdout);
  assert.deepEqual([body.result.state, body.result.configured, body.result.effective], ['paused', 2, 0]);
  assert.deepEqual(readFileSync(join(root, 'config.json')), before);
});

test('actual CLI refuses unknown inputs and outside/symlink paths without disclosing contents', () => {
  const cwd = mkdtempSync(join(root, '.cli-proof-'));
  try {
    writeFileSync(join(cwd, 'invalid.json'), '{"privateMarker":"SYNTHETIC-NOT-FOR-OUTPUT"}');
    symlinkSync('../config.json', join(cwd, 'linked.json'));
    for (const args of [ ['config', 'validate', '--config', '../config.json'],
      ['config', 'validate', '--config', 'linked.json'], ['config', 'validate', '--config', 'invalid.json'],
      ['config', 'validate', '--config', 'invalid.json', '--activate', 'true'] ]) {
      const result = run(cwd, ...args);
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stdout), { version: 1, code: 1, error: 'invalid-command-input-or-contract' });
      assert.equal(result.stderr, '');
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('scope inspection fails without intent and reports readable validation for valid input', () => {
  const cwd = mkdtempSync(join(root, '.cli-proof-'));
  try {
    const scope = scopeFixture({ intent: '', ref: 'chore/task' });
    writeFileSync(join(cwd, 'scope.json'), JSON.stringify(scope));
    assert.equal(run(cwd, 'scope', 'validate', '--scope', 'scope.json').status, 1);
    scope.intent = 'SYNTHETIC-INTENT'; writeFileSync(join(cwd, 'scope.json'), JSON.stringify(scope));
    const result = run(cwd, 'scope', 'validate', '--scope', 'scope.json');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).result,
      { state: 'scope-valid', slug: 'synthetic-feature', requestRevision: 1, designRevision: 1, criteria: 1, authority: 'shape-only' });
    assert.ok(!result.stdout.includes(scope.intent));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('scope creation captures the current Git source without asking for or printing its SHA', () => {
  const cwd = mkdtempSync(join(root, '.cli-proof-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--initial-branch=feature/guided-scope');
    writeFileSync(join(cwd, '.gitignore'), '.governance-artifacts/\n');
    writeFileSync(join(cwd, 'README.md'), '# fixture\n');
    const feature = join(cwd, 'docs/features/synthetic-feature');
    mkdirSync(feature, { recursive: true });
    writeFileSync(join(feature, 'request.md'), requestDocument());
    writeFileSync(join(feature, 'design.md'), designDocument());
    git('add', '.gitignore', 'README.md', 'docs');
    git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
    mkdirSync(join(cwd, '.governance-artifacts'));
    const head = git('rev-parse', 'HEAD'), result = run(cwd, 'scope', 'create',
      '--request', 'docs/features/synthetic-feature/request.md', '--design', 'docs/features/synthetic-feature/design.md',
      '--output', '.governance-artifacts/scope.json');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const body = JSON.parse(result.stdout), scope = JSON.parse(readFileSync(join(cwd, body.result.artifact)));
    assert.deepEqual(body.result, { artifact: '.governance-artifacts/scope.json', state: 'scope-created', slug: 'synthetic-feature',
      requestRevision: 1, designRevision: 1, source: 'captured-from-current-checkout' });
    assert.deepEqual(scope, scopeFixture({ ref: 'feature/guided-scope', sourceSha: head,
      intent: 'Deliver the accepted synthetic behavior.', intentSource: 'Direct user acceptance.',
      boundaries: 'Fixture files only.', assumptions: ['The fixture is local.'],
      criteria: [{ id: 'A', outcome: 'Complete A for the fixture.', method: 'Run the focused fixture proof.' }] }));
    assert.equal(result.stdout.includes(head), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('actual Git baseline is source-bound and never converts observations into readiness', () => {
  const cwd = mkdtempSync(join(root, '.cli-proof-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--initial-branch=task/example');
    git('remote', 'add', 'origin', 'https://github.com/example/baseline.git');
    writeFileSync(join(cwd, 'AGENTS.md'), '# Synthetic fixture policy\nNo external actions.\n');
    writeFileSync(join(cwd, 'project.json'), JSON.stringify({ schemaVersion: 1, repository: 'example/baseline', branchPrefixes: ['task'] }));
    writeFileSync(join(cwd, '.gitignore'), 'scope.json\n');
    git('add', 'AGENTS.md', 'project.json', '.gitignore');
    git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD'), before = git('status', '--porcelain');
    const scope = scopeFixture({ intent: 'Observe synthetic baseline', ref: 'task/example', sourceSha: sha,
      criteria: [{ id: 'A', outcome: 'Observe source', method: 'Git readback' }] });
    writeFileSync(join(cwd, 'scope.json'), JSON.stringify(scope));
    const args = ['baseline', '--scope', 'scope.json', '--project', 'project.json'];
    const observed = run(cwd, ...args), result = JSON.parse(observed.stdout).result;
    assert.equal(observed.status, 2);
    assert.deepEqual([result.status, result.machineChecks, result.dirty, result.source.sha, result.runtime], ['incomplete', 'passed', false, sha, 'not-observed']);
    assert.ok(result.requiredLeadReview.includes('authority-and-intent-coverage'));
    assert.equal(git('status', '--porcelain'), before); assert.equal(git('rev-parse', 'HEAD'), sha);
    writeFileSync(join(cwd, 'AGENTS.md'), '# Changed local policy\n');
    const dirty = run(cwd, ...args); assert.equal(dirty.status, 2); assert.equal(JSON.parse(dirty.stdout).result.dirty, true);
    rmSync(join(cwd, 'AGENTS.md')); assert.equal(run(cwd, ...args).status, 1);
    writeFileSync(join(cwd, 'AGENTS.md'), '# Synthetic fixture policy\nNo external actions.\n');
    scope.source.sha = 'a'.repeat(40); writeFileSync(join(cwd, 'scope.json'), JSON.stringify(scope));
    assert.equal(run(cwd, ...args).status, 1);
    scope.source.sha = sha; writeFileSync(join(cwd, 'scope.json'), JSON.stringify(scope));
    git('remote', 'set-url', 'origin', 'https://github.com/example/foreign.git');
    assert.equal(run(cwd, ...args).status, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('loop CLI returns source-bound build, human-review and report routes', () => {
  const cwd = mkdtempSync(join(root, '.cli-proof-'));
  const sha = 'a'.repeat(40), nextSha = 'b'.repeat(40), proof = `sha256:${'c'.repeat(64)}`;
  const scope = scopeFixture({ intent: 'Deliver fixture', ref: 'feature/task', sourceSha: sha,
    criteria: [{ id: 'A', outcome: 'Complete A', method: 'Focused test' }] });
  const policy = { schemaVersion: 1, maxIterations: 3, maxSameFailure: 2, maxElapsedMinutes: 60 };
  const row = (number, outcome, candidateSha = sha, patchProof = proof, recordedAt = '2026-09-22T08:05:00Z') => ({
    number, candidate: { ref: 'feature/task', sha: candidateSha, patchProof }, outcome, criteria: ['A'],
    evidence: [{ criterionId: 'A', kind: 'test', proof }], failureKey: outcome === 'SCOPE_VERIFIED' ? null : 'A:FAIL',
    intentProof: outcome === 'SCOPE_VERIFIED' ? proof : null, recordedAt,
  });
  const ledger = iterations => ({ schemaVersion: 1, scopeDigest: digest(scope), scopeRevision: 1,
    startedAt: '2026-09-22T08:00:00Z', observedAt: '2026-09-22T08:10:00Z', iterations });
  const inspect = (record, head, patch) => {
    writeFileSync(join(cwd, 'scope.json'), JSON.stringify(scope)); writeFileSync(join(cwd, 'policy.json'), JSON.stringify(policy));
    writeFileSync(join(cwd, 'record.json'), JSON.stringify(record));
    return run(cwd, 'loop', 'inspect', '--scope', 'scope.json', '--record', 'record.json', '--policy', 'policy.json',
      '--ref', 'feature/task', '--head', head, '--patch', patch);
  };
  try {
    const failed = row(1, 'IMPLEMENTATION_DEFECT');
    let result = inspect(ledger([failed]), sha, proof);
    assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).result.route, 'build');
    const verified = row(2, 'SCOPE_VERIFIED', nextSha, null, '2026-09-22T08:09:00Z');
    result = inspect(ledger([failed, verified]), nextSha, 'clean');
    assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).result.route, 'report');
    result = inspect(ledger([row(1, 'SCOPE_GAP')]), sha, proof);
    assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).result.route, 'human-design-review');
    result = inspect(ledger([row(1, 'ENVIRONMENT_FAILED'), row(2, 'ENVIRONMENT_FAILED', sha, proof, '2026-09-22T08:06:00Z')]), sha, proof);
    assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).result.stopReason, 'same-failure-limit');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
