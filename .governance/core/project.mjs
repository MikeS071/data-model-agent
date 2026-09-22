import assert from 'node:assert/strict';

// Supplied by the lead's source-bound project adapter, never a worker result.
export function inspectProject(project) {
  assert.deepEqual(Object.keys(project).sort(), ['branchPrefixes', 'repository', 'schemaVersion']);
  assert.equal(project.schemaVersion, 1);
  assert.match(project.repository, /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u);
  assert.ok(Array.isArray(project.branchPrefixes) && project.branchPrefixes.length > 0);
  assert.equal(new Set(project.branchPrefixes).size, project.branchPrefixes.length);
  project.branchPrefixes.forEach(prefix => assert.match(prefix, /^[a-z][a-z0-9-]*$/u));
  return project;
}
