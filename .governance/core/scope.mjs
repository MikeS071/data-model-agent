import { createHash } from 'node:crypto';

const text = value => typeof value === 'string' && value.trim().length > 0;
const fail = code => { throw new Error(code); };
const exact = (value, names, code) => {
  if (!value || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) fail(code);
};
const strings = (value, code) => {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !text(item)) || new Set(value).size !== value.length) fail(code);
};
const positive = value => Number.isSafeInteger(value) && value > 0;

// Validates completeness and binding shape, not the truth or authority of approvals.
export function validateScope(scope) {
  exact(scope, ['version', 'revision', 'intent', 'intentSource', 'boundaries', 'assumptions', 'exclusions', 'documents', 'source', 'criteria'], 'SCOPE_INVALID');
  if (scope.version !== 2 || !positive(scope.revision) || !text(scope.intent) || !text(scope.intentSource) || !text(scope.boundaries)) fail('SCOPE_INVALID');
  strings(scope.assumptions, 'SCOPE_INVALID'); strings(scope.exclusions, 'SCOPE_INVALID');
  exact(scope.source, ['ref', 'sha'], 'SCOPE_INVALID');
  if (!text(scope.source.ref) || !/^[a-f0-9]{40}$/u.test(scope.source.sha ?? '')) fail('SCOPE_INVALID');

  exact(scope.documents, ['slug', 'request', 'design'], 'SCOPE_INVALID');
  const slug = scope.documents.slug;
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(slug ?? '')) fail('SCOPE_INVALID');
  exact(scope.documents.request, ['path', 'revision'], 'SCOPE_INVALID');
  exact(scope.documents.design, ['path', 'revision', 'requestRevision', 'decisions'], 'SCOPE_INVALID');
  if (scope.documents.request.path !== `docs/features/${slug}/request.md`
    || scope.documents.design.path !== `docs/features/${slug}/design.md`
    || !positive(scope.documents.request.revision) || !positive(scope.documents.design.revision)
    || scope.documents.design.requestRevision !== scope.documents.request.revision
    || scope.revision !== scope.documents.design.revision) fail('SCOPE_INVALID');
  strings(scope.documents.design.decisions, 'SCOPE_INVALID');
  if (scope.documents.design.decisions.some(id => !/^D-[0-9]{3}$/u.test(id))) fail('SCOPE_INVALID');

  if (!Array.isArray(scope.criteria) || scope.criteria.length === 0) fail('SCOPE_INVALID');
  const ids = scope.criteria.map(criterion => criterion?.id);
  if (new Set(ids).size !== ids.length || scope.criteria.some(criterion => {
    try { exact(criterion, ['id', 'outcome', 'method'], 'SCOPE_INVALID'); } catch { return true; }
    return !/^[A-Z][A-Z0-9-]*$/u.test(criterion.id ?? '') || !text(criterion.outcome) || !text(criterion.method);
  })) fail('SCOPE_INVALID');
  return scope;
}

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
