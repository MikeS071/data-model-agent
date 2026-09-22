#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { validateScope } from './core/scope.mjs';
import { bindDocuments } from './core/specification.mjs';
import { inspectConfig, inspectResult } from './core/contracts.mjs';
import { context, adapter, applyPlan, projectFile, receiptFile, withApplyLock } from './core/actions.mjs';
import { makePlan, GovernanceError } from './core/plan.mjs';
import { reviewPlan, inspectReview } from './core/review.mjs';
import { artifact, reviewBundle, usageSnapshot, collectUsage } from './core/economy.mjs';
import { usageReport } from './core/cost.mjs';
import { runVerification } from './core/verification.mjs';
import { inspectBaseline } from './core/baseline.mjs';
import { inspectLoop } from './core/loop.mjs';

// Explicit action apply is the sole repository-writing route. No merge or provisioning.
const routes = {
  'review bundle': ['scope', 'delivery', 'head', 'base', 'target', 'request', 'output'],
  'usage snapshot': ['scope', 'source', 'output'],
  'usage collect': ['scope', 'request', 'output'],
  'usage report': ['scope', 'record'],
  'review plan': ['scope', 'delivery', 'head', 'base', 'target'],
  'review check': ['scope', 'delivery', 'head', 'base', 'target', 'record'],
  'verify run': ['scope', 'project', 'check'],
  'action plan': ['scope', 'request', 'delivery'],
  'action apply': ['scope', 'request', 'delivery', 'plan'],
  'baseline': ['scope', 'project'],
  'scope create': ['request', 'design', 'output'],
  'scope validate': ['scope'],
  'config validate': ['config'],
  'result inspect': ['scope', 'record', 'project', 'head'],
  'loop inspect': ['scope', 'record', 'policy', 'ref', 'head', 'patch'],
};
function read(path) {
  const root = realpathSync(process.cwd()), full = resolve(root, path), rel = relative(root, full);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || realpathSync(full) !== full || !statSync(full).isFile() || statSync(full).size > 200000) throw new Error('invalid-path');
  return JSON.parse(readFileSync(full, 'utf8'));
}
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node dev-stack.mjs COMMAND OPTIONS\n' + Object.entries(routes).map(([name, flags]) => `  ${name} ${flags.map(x => `--${x} VALUE`).join(' ')}`).join('\n') +
      '\nInput files stay inside the current directory. Scope creation requires accepted committed request/design Markdown; other records are JSON. Baseline observes its enclosing Git repository. Action plan reads GitHub; action apply writes only the reviewed plan and local receipts. --head is a lead-observed source, not verified by this inspector. Exit 0 means valid inspection, never authority or proof a workload succeeded; inspect acceptedScope/outcomeCode. No dispatch, merge, installation or provider provisioning.');
  } else {
    const command = args[0] === 'baseline' ? 'baseline' : args.slice(0, 2).join(' '), flags = routes[command];
    if (!flags) throw new Error('invalid-command');
    const { values } = parseArgs({ args: args.slice(command === 'baseline' ? 1 : 2), options: Object.fromEntries(flags.map(name => [name, { type: 'string' }])) });
    if (flags.some(name => !values[name])) throw new Error('missing-input');
    let result, code = 0;
    if (command === 'review bundle') {
      const delivery = read(values.delivery), ctx = context(process.cwd(), delivery);
      const outcome = reviewBundle(ctx, read(values.scope), { ...values, staging: values.target }, read(values.request));
      result = outcome.result; code = outcome.code;
    } else if (command.startsWith('usage ')) {
      const scope = read(values.scope);
      if (command === 'usage report') { const { entries, ...summary } = usageReport(scope, read(values.record)); result = { ...summary, entryCount: entries.length }; }
      else {
        const root = realpathSync(process.cwd());
        const value = command === 'usage snapshot' ? await usageSnapshot(root, scope, values.source) : collectUsage(root, scope, read(values.request));
        if (command === 'usage collect') usageReport(scope, value);
        result = artifact(root, values.output, value);
      }
    } else if (command.startsWith('review ')) {
      const scope = read(values.scope), delivery = read(values.delivery), ctx = context(process.cwd(), delivery);
      const plan = reviewPlan({ cwd: ctx.root, scope, delivery, head: values.head, reviewBase: values.base, stagingBase: values.target });
      result = { plan, review: inspectReview(plan, values.record ? read(values.record) : null, scope) };
      code = command === 'review check' ? result.review.code : 0;
    } else if (command === 'verify run') {
      result = runVerification({ cwd: process.cwd(), scope: read(values.scope), project: read(values.project), check: values.check }); code = result.code;
    } else if (command.startsWith('action ')) {
      const delivery = read(values.delivery), scope = read(values.scope), request = read(values.request);
      const ctx = context(process.cwd(), delivery), io = adapter(ctx);
      if (command === 'action plan') {
        result = makePlan(request, scope, io.snapshot(request, scope), ctx.templates, delivery);
        code = request.authority === null ? 2 : 0;
      } else {
        const path = projectFile(ctx.root, values.plan), supplied = read(values.plan);
        const plan = supplied.command === 'action plan' && supplied.code === 0 ? supplied.result : supplied;
        result = withApplyLock(path, () => applyPlan({ plan, scope, request, templates: ctx.templates, delivery, adapter: io, receipt: receiptFile(path) }));
      }
    }
    else if (command === 'baseline') { result = inspectBaseline({ cwd: process.cwd(), scope: read(values.scope), project: read(values.project) }); code = 2; }
    else if (command === 'scope create') {
      const root = realpathSync(process.cwd());
      const scope = bindDocuments({ root, requestPath: values.request, designPath: values.design });
      const saved = artifact(root, values.output, scope);
      result = { artifact: saved.path, state: 'scope-created', slug: scope.documents.slug,
        requestRevision: scope.documents.request.revision, designRevision: scope.documents.design.revision,
        source: 'captured-from-current-checkout' };
    }
    else if (command === 'scope validate') {
      const scope = read(values.scope); validateScope(scope);
      result = { state: 'scope-valid', slug: scope.documents.slug, requestRevision: scope.documents.request.revision,
        designRevision: scope.documents.design.revision, criteria: scope.criteria.length, authority: 'shape-only' };
    }
    else if (command === 'config validate') { result = inspectConfig(read(values.config)); code = result.state === 'blocked' ? 2 : 0; }
    else if (command === 'loop inspect') {
      result = inspectLoop({ scope: read(values.scope), record: read(values.record), policy: read(values.policy),
        currentRef: values.ref, currentHead: values.head, currentPatchProof: values.patch === 'clean' ? null : values.patch });
      code = result.code;
    }
    else {
      result = inspectResult({ ...read(values.record), scope: read(values.scope), project: read(values.project), currentHead: values.head });
      code = result.code;
    }
    console.log(JSON.stringify({ version: 1, command, code, result }));
    process.exitCode = code;
  }
} catch (error) {
  const code = error instanceof GovernanceError ? error.code : 1;
  console.log(JSON.stringify({ version: 1, code, error: error instanceof GovernanceError ? error.reason : 'invalid-command-input-or-contract' }));
  process.exitCode = code;
}
