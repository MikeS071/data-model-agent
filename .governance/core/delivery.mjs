import assert from 'node:assert/strict';
import { inspectProject } from './project.mjs';

// Project-authored settings describe targets; they never supply action approval.
export function inspectDelivery(value) {
  assert.deepEqual(Object.keys(value).sort(), ['baseBranch', 'instructionPaths', 'project', 'queue', 'schemaVersion', 'templates']);
  assert.equal(value.schemaVersion, 1);
  inspectProject(value.project);
  assert.match(value.baseBranch, /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u);
  assert.ok(!value.baseBranch.includes('..') && !value.baseBranch.endsWith('/') && !value.baseBranch.endsWith('.lock'));
  assert.ok(value.queue === null || Number.isSafeInteger(value.queue) && value.queue > 0);
  const path = name => {
    assert.equal(typeof name, 'string');
    assert.ok(name.split('/').every(part => /^[A-Za-z0-9_.-]+$/u.test(part) && !['.', '..'].includes(part)));
    assert.ok(!/(?:^|\/)(?:\.git|\.env(?:\..*)?)($|\/)/u.test(name));
  };
  assert.ok(Array.isArray(value.instructionPaths) && value.instructionPaths.includes('AGENTS.md'));
  assert.equal(new Set(value.instructionPaths).size, value.instructionPaths.length);
  value.instructionPaths.forEach(path);
  assert.deepEqual(Object.keys(value.templates).sort(), ['issue', 'pr']);
  Object.values(value.templates).forEach(path);
  return value;
}
