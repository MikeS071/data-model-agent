import assert from 'node:assert/strict';
import { createReadStream, readFileSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { digest, validateScope } from './scope.mjs';
import { git, projectFile } from './actions.mjs';
import { reviewPlan } from './review.mjs';
import { inspectVerification } from './verification.mjs';
import { normalizeUsage, snapshotDelta, usageReport } from './cost.mjs';

const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), names.slice().sort());
const json = (root, path) => JSON.parse(readFileSync(projectFile(root, path), 'utf8'));
export function artifact(root, path, value) {
  const target = resolve(root, path), rel = relative(root, target), data = JSON.stringify(value, null, 2) + '\n';
  assert.ok(rel.startsWith('.governance-artifacts/') && realpathSync(dirname(target)) === dirname(target), 'unsafe-artifact-path');
  git(root, 'check-ignore', '--quiet', '--', rel);
  writeFileSync(target, data, { flag: 'wx', mode: 0o600 }); // No replacement of a previous run or symlink.
  return { path: rel, digest: digest(value), bytes: Buffer.byteLength(data) };
}
export async function usageSnapshot(root, scope, source) {
  validateScope(scope);
  const path = resolve(source), home = realpathSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'));
  assert.ok(path.startsWith(home + '/') && realpathSync(path) === path && lstatSync(path).isFile(), 'unsafe-session-source');
  let latest = null, model = null, sessionModel = null; const models = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'turn_context') {
      model = typeof row.payload?.model === 'string' ? row.payload.model : null;
      if (models.at(-1) !== model) models.push(model);
    }
    if (row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info?.total_token_usage) {
      latest = { timestamp: row.timestamp, usage: normalizeUsage(row.payload.info.total_token_usage) }; sessionModel = model;
    }
  }
  assert.ok(latest && sessionModel && Number.isFinite(Date.parse(latest.timestamp)), 'usage-unavailable');
  return { version: 1, scopeDigest: digest(scope), threadDigest: digest(path), model: sessionModel, modelDigest: digest(models), ...latest };
}
export function collectUsage(root, scope, request) {
  validateScope(scope); keys(request, ['complete', 'workers', 'lead']); assert.equal(typeof request.complete, 'boolean');
  const entries = [], windows = new Map(); let complete = request.complete;
  for (const row of request.workers) {
    keys(row, ['result', 'scopeDigest', 'phase']); assert.ok(['worker', 'correction'].includes(row.phase));
    const receipt = json(root, row.result), diagnostics = json(root, join(dirname(row.result), 'worker-diagnostics.json'));
    assert.equal(digest(receipt.contract.scope), row.scopeDigest);
    const id = receipt.contract.assignment.attemptId;
    assert.equal(typeof id, 'string');
    if (diagnostics.usage_status !== 'reported' || !diagnostics.usage_events.length) complete = false;
    for (const [index, usage] of diagnostics.usage_events.entries()) entries.push({ id: `${id}:${index}`, model: receipt.model, phase: row.phase, usage: normalizeUsage(usage) });
  }
  for (const row of request.lead) {
    keys(row, ['before', 'after', 'phase']); assert.ok(['review', 'coordination', 'setup'].includes(row.phase));
    const before = json(root, row.before), after = json(root, row.after);
    assert.equal(before.scopeDigest, digest(scope));
    const usage = snapshotDelta(before, after), intervals = windows.get(before.threadDigest) ?? [];
    assert.ok(intervals.every(([a, b]) => after.timestamp <= a || before.timestamp >= b), 'overlapping-usage-windows');
    intervals.push([before.timestamp, after.timestamp]); windows.set(before.threadDigest, intervals);
    entries.push({ id: digest({ before, after }), model: before.model, phase: row.phase, usage });
  }
  return { version: 1, scopeDigest: digest(scope), complete, entries };
}
function safeText(text) {
  assert.ok(!/\x00|sk-or-v1-[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text), 'sensitive-or-binary-content');
  for (const [name, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/u.test(name) && value.length >= 12) assert.ok(!text.includes(value), 'sensitive-content');
  }
  return text;
}
function sourceText(root, head, path) {
  assert.ok(typeof path === 'string' && path && !path.startsWith('/') && !path.split('/').some(x => ['..', '.', '.git', '.governance-artifacts', '.imports', 'node_modules'].includes(x)) && !/(?:^|\/)(?:\.env(?:\.|$)|[^/]*\.(?:pem|key)$)/u.test(path), 'unsafe-context-path');
  const tree = git(root, 'ls-tree', head, '--', path);
  assert.match(tree, /^100(?:644|755) blob /u, 'context-must-be-regular-tracked-file');
  return safeText(execFileSync('git', ['--no-optional-locks', '-C', root, 'show', `${head}:${path}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1000000 }));
}
export function reviewBundle(ctx, scope, values, request, execute = spawnSync) {
  keys(request, ['context', 'principles', 'checks', 'ledger', 'reasoning']);
  keys(request.reasoning, ['effort', 'reason']);
  assert.ok(['medium', 'high'].includes(request.reasoning.effort));
  if (request.reasoning.effort === 'high') assert.ok(typeof request.reasoning.reason === 'string' && request.reasoning.reason.trim().length >= 20, 'high-requires-concrete-reason');
  else assert.equal(request.reasoning.reason, null);
  const plan = reviewPlan({ cwd: ctx.root, scope, head: values.head, reviewBase: values.base, stagingBase: values.staging, delivery: ctx.delivery });
  const costs = usageReport(scope, json(ctx.root, request.ledger));
  assert.equal(plan.staging.binaryFiles, 0, 'binary-needs-explicit-review-outside-text-bundle');
  const paths = new Set([...ctx.delivery.instructionPaths, ...request.context]);
  for (const id of request.principles) {
    const item = plan.policy.items.find(x => x.id === id); assert.ok(item?.skill, 'unknown-principle'); paths.add(item.skill);
  }
  const context = Object.fromEntries([...paths].sort().map(path => [path, sourceText(ctx.root, values.head, path)]));
  for (const row of plan.staging.files) { // Validate every changed path, including deletions, before assembling the full patch.
    const ref = git(ctx.root, 'ls-tree', values.head, '--', row.path) ? values.head : plan.staging.mergeBase;
    sourceText(ctx.root, ref, row.path);
  }
  const patches = Object.fromEntries([...new Set([values.base, values.staging])].map(base => [base, safeText(git(ctx.root, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', `${base}...${values.head}`) + '\n')]));
  const packet = { version: 1, scope, plan, context, patches, reasoning: { ...request.reasoning, verbosity: 'low', appliedToDesktop: false }, costs };
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 1000000, 'bundle-too-large-split-scope-or-review-explicitly');
  const config = inspectVerification(JSON.parse(sourceText(ctx.root, values.head, ".governance/verification.json")));
  const checkCommands = Object.fromEntries(Object.entries(config.commands).map(([name, argv]) => [name, [argv[0], argv.slice(1)]]));
  const names = new Set();
  for (const row of request.checks) {
    keys(row, ['name', 'criteria']); assert.ok(Object.hasOwn(checkCommands, row.name) && !names.has(row.name)); names.add(row.name);
    assert.ok(row.criteria.length && row.criteria.every(id => scope.criteria.some(x => x.id === id)));
  }
  // Keep all output in private artifacts, including failed checks; stdout contains status/digests only.
  const checks = request.checks.map(row => {
    const [program, args] = checkCommands[row.name];
    const run = execute(program, args, { cwd: ctx.root, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, maxBuffer: 8000000 });
    return { ...row, command: [program, ...args], exit: run.error ? null : run.status, signal: run.signal ?? null,
      outputComplete: !run.error, stdout: safeText(run.stdout ?? ''), stderr: safeText(run.stderr ?? '') };
  });
  assert.equal(git(ctx.root, 'rev-parse', 'HEAD'), values.head, 'source-changed-during-checks');
  assert.equal(git(ctx.root, 'status', '--porcelain'), '', 'source-changed-during-checks');
  const evidence = artifact(ctx.root, values.output + '.checks.json', { source: plan.source, scopeDigest: plan.scopeDigest, checks });
  const summary = checks.map(({ stdout, stderr, ...row }) => row);
  const criteria = scope.criteria.map(row => ({ ...row, checks: summary.filter(x => x.criteria.includes(row.id)).map(x => x.name), acceptance: 'lead-verification-required' }));
  const bundle = artifact(ctx.root, values.output, { ...packet, evidence, checks: summary, criteria,
    metadata: { base: ctx.delivery.baseBranch, head: values.head, scopeDigest: plan.scopeDigest, intent: scope.intent, acceptance: 'not-evaluated', mergeAuthority: 'none' } });
  return { result: { artifact: bundle, evidence, source: plan.source, criteria: criteria.map(x => ({ id: x.id, checks: x.checks, acceptance: x.acceptance })),
    checks: summary, reasoning: packet.reasoning, missingContext: 'lead requests specific paths then rebuilds; no completeness claim for selected context' },
    code: checks.some(x => x.exit !== 0 || !x.outputComplete) ? 1 : 0 };
}
