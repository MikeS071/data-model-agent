import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { digest, validateScope } from './scope.mjs';
import { git } from './actions.mjs';
import { inspectBaseline } from './baseline.mjs';

export function inspectVerification(config) {
  assert.deepEqual(Object.keys(config).sort(), ['commands', 'schemaVersion']);
  assert.equal(config.schemaVersion, 1);
  assert.ok(config.commands && typeof config.commands === 'object' && !Array.isArray(config.commands));
  for (const [id, argv] of Object.entries(config.commands)) {
    assert.match(id, /^[a-z][a-z0-9-]{0,63}$/u);
    assert.ok(Array.isArray(argv) && argv.length > 0 && argv.length <= 64);
    argv.forEach(arg => assert.ok(typeof arg === 'string' && arg.length > 0 && arg.length <= 4096 && !/[\x00\r\n]/u.test(arg)));
    assert.ok(['node', 'python3', 'git', 'pnpm', 'npm', 'go', 'cargo'].includes(argv[0]), 'Unsupported tool; configure a supported reviewed command');
  }
  return config;
}

function readConfig(cwd, ref) {
  const path = '.governance/verification.json';
  assert.match(git(cwd, 'ls-tree', ref, '--', path), /^100644 blob /u);
  return inspectVerification(JSON.parse(git(cwd, 'show', `${ref}:${path}`)));
}

export function verificationPlan({ cwd, base, head, scope }) {
  validateScope(scope);
  const before = readConfig(cwd, base), current = readConfig(cwd, head);
  const unresolved = [];
  if (!Object.keys(current.commands).length) unresolved.push('project-verification-unconfigured');
  if (digest(before) !== digest(current)) unresolved.push('verification-policy-changed');
  const plan = { applicability: 'configured-project-commands', scopeDigest: digest(scope), source: { base, head },
    configDigest: digest(current), checks: Object.keys(current.commands).sort(), unresolved,
    authority: 'command-capability-only; lead selects affected checks and independently verifies complete intent and criteria' };
  return { ...plan, digest: digest(plan) };
}

// Explicit invocation requires the lead's ordinary scoped execution authority.
// Commands come from the reviewed commit, never from an action/worker response.
export function runVerification({ cwd, scope, project, check }) {
  const baseline = inspectBaseline({ cwd, scope, project });
  assert.equal(baseline.dirty, false, 'Verification requires a clean source');
  const config = readConfig(baseline.checkout, scope.source.sha);
  assert.ok(Object.hasOwn(config.commands, check), 'Unsupported check');
  const [program, ...args] = config.commands[check];
  const run = spawnSync(program, args, { cwd: baseline.checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8000000 });
  return { code: !run.error && run.status === 0 ? 0 : 1, check, source: baseline.source, configDigest: digest(config),
    exit: run.error ? null : run.status, outputRetained: false,
    acceptance: 'unverified; command success cannot establish every criterion or complete intent' };
}
