import { createHash } from "node:crypto";

const text = (value) => typeof value === "string" && value.trim().length > 0;
const fail = (code) => { throw new Error(code); };
// Validates completeness, not authority, truth or coverage of the user's intent.
export function validateScope(scope) {
  if (!scope || scope.version !== 1 || !Number.isSafeInteger(scope.revision) || scope.revision < 1
    || !text(scope.intent) || !text(scope.intentSource) || !text(scope.boundaries)
    || !text(scope.source?.ref) || !/^[a-f0-9]{40}$/u.test(scope.source?.sha ?? "")
    || !Array.isArray(scope.criteria) || scope.criteria.length === 0) fail("SCOPE_INVALID");
  const ids = scope.criteria.map((criterion) => criterion?.id);
  if (new Set(ids).size !== ids.length || scope.criteria.some((criterion) => !criterion
    || !/^[A-Z][A-Z0-9-]*$/u.test(criterion.id ?? "") || !text(criterion.outcome) || !text(criterion.method))) fail("SCOPE_INVALID");
  return scope;
}

export function bindScope(request, source) {
  if (!request || Object.keys(request).sort().join(',') !== 'boundaries,criteria,intent,intentSource,revision,version') fail('SCOPE_REQUEST_INVALID');
  return validateScope({ ...request, source });
}


export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
