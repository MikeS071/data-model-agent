import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { bindDocuments, parseDesignDocument, parseRequestDocument } from '../core/specification.mjs';
import { designDocument, requestDocument } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repository() {
  const cwd = mkdtempSync(join(root, '.specification-proof-'));
  git(cwd, 'init', '--initial-branch=feature/synthetic-feature');
  const directory = join(cwd, 'docs/features/synthetic-feature'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.md'), requestDocument());
  writeFileSync(join(directory, 'design.md'), designDocument());
  writeFileSync(join(cwd, '.gitignore'), '.governance-artifacts/\n');
  git(cwd, 'add', '.');
  git(cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'accepted pair');
  mkdirSync(join(cwd, '.governance-artifacts'));
  return cwd;
}

test('accepted Markdown parses into a matching scope-v2 contract', () => {
  const request = parseRequestDocument(requestDocument()), design = parseDesignDocument(designDocument());
  assert.deepEqual([request.slug, request.revision, request.criteria[0].id], ['synthetic-feature', 1, 'A']);
  assert.deepEqual([design.slug, design.requestRevision, design.decisions], ['synthetic-feature', 1, ['D-001']]);
  const cwd = repository();
  try {
    const scope = bindDocuments({ root: cwd, requestPath: 'docs/features/synthetic-feature/request.md',
      designPath: 'docs/features/synthetic-feature/design.md', source: { ref: git(cwd, 'branch', '--show-current'), sha: git(cwd, 'rev-parse', 'HEAD') } });
    assert.deepEqual([scope.version, scope.revision, scope.documents.slug, scope.criteria[0].id], [2, 1, 'synthetic-feature', 'A']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('the approved dev-stack workflow documents satisfy the same public contract', () => {
  const feature = join(root, '..', 'docs/features/human-readable-design-gates');
  const request = parseRequestDocument(readFileSync(join(feature, 'request.md'), 'utf8'));
  const design = parseDesignDocument(readFileSync(join(feature, 'design.md'), 'utf8'));
  assert.deepEqual([request.slug, request.status, design.slug, design.status, design.requestRevision],
    ['human-readable-design-gates', 'accepted', 'human-readable-design-gates', 'accepted', 1]);
});

test('draft, incomplete, mismatched, dirty and legacy inputs are refused', () => {
  assert.throws(() => parseRequestDocument(requestDocument({ status: 'proposed' })));
  assert.throws(() => parseDesignDocument(designDocument().replace('## Security and privacy', '## Privacy')));
  const cwd = repository();
  try {
    const args = { root: cwd, requestPath: 'docs/features/synthetic-feature/request.md',
      designPath: 'docs/features/synthetic-feature/design.md', source: { ref: 'feature/synthetic-feature', sha: git(cwd, 'rev-parse', 'HEAD') } };
    writeFileSync(join(cwd, args.designPath), designDocument({ requestRevision: 2 }));
    assert.throws(() => bindDocuments(args));
    writeFileSync(join(cwd, args.designPath), designDocument());
    assert.doesNotThrow(() => bindDocuments(args));
    writeFileSync(join(cwd, args.designPath), `${designDocument()}\nchanged\n`);
    assert.throws(() => bindDocuments(args));
    assert.throws(() => bindDocuments({ ...args, requestPath: '.governance-artifacts/request.json' }));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
