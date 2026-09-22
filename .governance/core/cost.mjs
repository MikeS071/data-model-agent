import assert from 'node:assert/strict';
import { digest, validateScope } from './scope.mjs';

export const reviewDefaults = { reasoning: 'medium', verbosity: 'low' };
export const pricing = { version: '2026-09-15', currency: 'USD', creditBilling: 'unverified',
  source: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
  models: { 'gpt-6-astra': { input: 10, output: 50, cached: 1, write: 12.5, contextThreshold: 272000 } } };
const count = value => assert.ok(Number.isSafeInteger(value) && value >= 0, 'invalid-token-count');
const money = value => assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'invalid-cost');
const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());
export function reviewSettings(config) {
  const value = Object.hasOwn(config, 'review') ? config.review : reviewDefaults;
  keys(value, Object.keys(reviewDefaults));
  assert.equal(value.reasoning, 'medium'); assert.equal(value.verbosity, 'low');
  return value;
}
export const tokenFields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
export function normalizeUsage(value) {
  const result = Object.fromEntries([...tokenFields, 'cost_usd'].map(key => [key, value?.[key] ?? null]));
  for (const key of tokenFields) if (result[key] !== null) count(result[key]);
  if (result.cost_usd !== null) money(result.cost_usd);
  const { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cache_write_input_tokens: write, reasoning_output_tokens: reasoning } = result;
  if (input !== null && cached !== null) assert.ok(cached <= input, 'cache-exceeds-input');
  if (input !== null && write !== null) assert.ok(write + (cached ?? 0) <= input, 'cache-write-exceeds-input');
  if (output !== null && reasoning !== null) assert.ok(reasoning <= output, 'reasoning-exceeds-output');
  return result;
}
export function snapshotDelta(before, after) {
  for (const key of ['scopeDigest', 'threadDigest', 'model', 'modelDigest']) assert.equal(before[key], after[key], 'snapshot-identity-changed');
  for (const row of [before, after]) {
    assert.equal(row.version, 1); assert.match(row.modelDigest, /^[a-f0-9]{64}$/u); assert.ok(Number.isFinite(Date.parse(row.timestamp))); normalizeUsage(row.usage);
  }
  assert.ok(after.timestamp > before.timestamp, 'snapshot-order-invalid');
  const usage = {};
  for (const key of tokenFields) {
    const a = before.usage[key], b = after.usage[key];
    usage[key] = a === null || b === null ? null : b - a;
  }
  return normalizeUsage(usage); // Reset/decreasing counters fail; never turn them into zero cost.
}
const sum = values => values.some(value => value === null) ? null : values.reduce((a, b) => a + b, 0);
export function usageReport(scope, ledger) {
  validateScope(scope); keys(ledger, ['version', 'scopeDigest', 'complete', 'entries']);
  assert.equal(ledger.version, 1); assert.equal(ledger.scopeDigest, digest(scope));
  assert.equal(typeof ledger.complete, 'boolean'); assert.ok(Array.isArray(ledger.entries));
  const ids = new Set();
  const entries = ledger.entries.map(row => {
    keys(row, ['id', 'model', 'phase', 'usage']); assert.equal(typeof row.model, 'string');
    assert.match(row.id, /^[a-zA-Z0-9_.:-]{1,160}$/u); assert.ok(!ids.has(row.id), 'duplicate-usage'); ids.add(row.id);
    assert.ok(['review', 'coordination', 'worker', 'correction', 'setup'].includes(row.phase));
    const usage = normalizeUsage(row.usage), rates = Object.hasOwn(pricing.models, row.model) ? pricing.models[row.model] : null;
    const { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cache_write_input_tokens: write } = usage;
    const valuationUsd = rates && input !== null && output !== null ? (input * rates.input + output * rates.output) / 1e6 : null;
    // Aggregate events cannot establish per-request long-context or service-tier charges.
    const apiEstimateUsd = rates && input !== null && output !== null && cached !== null && write !== null &&
      (!write || rates.write !== null) && (rates.contextThreshold === null || input <= rates.contextThreshold)
      ? ((input - cached - write) * rates.input + cached * rates.cached + write * (rates.write ?? 0) + output * rates.output) / 1e6 : null;
    return { ...row, usage, valuationUsd, apiEstimateUsd, reportedCostUsd: usage.cost_usd };
  });
  const totals = rows => ({ inputTokens: sum(rows.map(x => x.usage.input_tokens)), outputTokens: sum(rows.map(x => x.usage.output_tokens)),
    valuationUsd: sum(rows.map(x => x.valuationUsd)), apiEstimateUsd: sum(rows.map(x => x.apiEstimateUsd)), reportedCostUsd: sum(rows.map(x => x.reportedCostUsd)) });
  const review = totals(entries.filter(x => ['review', 'coordination'].includes(x.phase)));
  return { scopeDigest: digest(scope), complete: ledger.complete, pricing, entries, total: ledger.complete ? totals(entries) : null, knownSubtotal: totals(entries), review,
    acceptance: 'not-evaluated; join existing independent scope acceptance by scopeDigest',
    billing: 'valuation uses full input rates; API estimate assumes Standard tier and known fields; reported cost is separate, credits unverified',
    enforcement: 'measurement-only; no review token or dollar budget' };
}
