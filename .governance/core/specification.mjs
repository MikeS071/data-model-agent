import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { validateScope } from './scope.mjs';

const fail = code => { throw new Error(code); };
const normalized = value => value.trim().replace(/\s+/gu, ' ');
const exact = (value, names, code) => {
  if (!value || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) fail(code);
};
const positive = value => Number.isSafeInteger(value) && value > 0;

function frontmatter(markdown, expected) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/u);
  if (!match) fail('DOCUMENT_FRONTMATTER_INVALID');
  const metadata = {};
  for (const line of match[1].split('\n')) {
    const row = line.match(/^([A-Za-z][A-Za-z0-9]*): ([A-Za-z0-9-]+)$/u);
    if (!row || Object.hasOwn(metadata, row[1])) fail('DOCUMENT_FRONTMATTER_INVALID');
    metadata[row[1]] = ['version', 'revision', 'requestRevision'].includes(row[1]) ? Number(row[2]) : row[2];
  }
  exact(metadata, expected, 'DOCUMENT_FRONTMATTER_INVALID');
  if (metadata.version !== 1 || !positive(metadata.revision) || metadata.status !== 'accepted'
    || !/^[a-z][a-z0-9-]{1,63}$/u.test(metadata.slug ?? '')) fail('DOCUMENT_NOT_ACCEPTED');
  return { metadata, body: match[2] };
}

function sections(body, expected) {
  const matches = [...body.matchAll(/^## ([^\n]+)\n/gmu)], found = {};
  for (const [index, match] of matches.entries()) {
    const name = match[1], start = match.index + match[0].length, end = matches[index + 1]?.index ?? body.length;
    if (Object.hasOwn(found, name)) fail('DOCUMENT_SECTION_INVALID');
    found[name] = body.slice(start, end).trim();
  }
  exact(found, expected, 'DOCUMENT_SECTION_INVALID');
  if (Object.values(found).some(value => !value)) fail('DOCUMENT_SECTION_INVALID');
  return found;
}

function list(value) {
  const rows = [];
  for (const line of value.split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^- (.+)$/u);
    if (item) rows.push(item[1].trim());
    else if (rows.length && !/^#|^\|/u.test(line)) rows[rows.length - 1] += ` ${line.trim()}`;
    else fail('DOCUMENT_LIST_INVALID');
  }
  if (!rows.length || rows.some(row => !row) || new Set(rows).size !== rows.length) fail('DOCUMENT_LIST_INVALID');
  return rows;
}

function criteria(value) {
  const matches = [...value.matchAll(/^### ([A-Z][A-Z0-9-]*)\n/gmu)], rows = [];
  if (!matches.length || value.slice(0, matches[0].index).trim()) fail('DOCUMENT_CRITERIA_INVALID');
  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length, end = matches[index + 1]?.index ?? value.length;
    const content = value.slice(start, end).trim();
    const fields = content.match(/^\*\*Outcome:\*\*\s+([\s\S]+?)\n+\*\*Proof:\*\*\s+([\s\S]+)$/u);
    if (!fields) fail('DOCUMENT_CRITERIA_INVALID');
    rows.push({ id: match[1], outcome: normalized(fields[1]), method: normalized(fields[2]) });
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail('DOCUMENT_CRITERIA_INVALID');
  return rows;
}

function accepted(value) {
  if (!/^Status: accepted\./u.test(normalized(value))) fail('DOCUMENT_APPROVAL_INVALID');
}

export function parseRequestDocument(markdown) {
  const { metadata, body } = frontmatter(markdown, ['kind', 'version', 'revision', 'status', 'slug']);
  if (metadata.kind !== 'request') fail('DOCUMENT_KIND_INVALID');
  const content = sections(body, ['Intent', 'Intent source', 'Boundaries', 'Assumptions', 'Exclusions', 'Acceptance criteria', 'Approval']);
  accepted(content.Approval);
  return { ...metadata, intent: normalized(content.Intent), intentSource: normalized(content['Intent source']),
    boundaries: list(content.Boundaries), assumptions: list(content.Assumptions), exclusions: list(content.Exclusions),
    criteria: criteria(content['Acceptance criteria']) };
}

function mermaid(value, pattern) {
  const blocks = [...value.matchAll(/```mermaid\n([\s\S]*?)\n```/gu)];
  if (blocks.length !== 1 || !pattern.test(blocks[0][1])) fail('DOCUMENT_MERMAID_INVALID');
}

function decisions(value) {
  const lines = value.split('\n').map(line => line.trim()).filter(Boolean);
  const cells = line => line.slice(1, -1).split('|').map(item => item.trim());
  if (lines.length < 3 || lines.some(line => !line.startsWith('|') || !line.endsWith('|'))) fail('DOCUMENT_DECISIONS_INVALID');
  if (cells(lines[0]).join('|') !== 'ID|Decision|Rationale|Alternatives|Consequences'
    || cells(lines[1]).some(item => !/^:?-{3,}:?$/u.test(item))) fail('DOCUMENT_DECISIONS_INVALID');
  const rows = lines.slice(2).map(cells);
  if (rows.some(row => row.length !== 5 || !/^D-[0-9]{3}$/u.test(row[0]) || row.some(item => !item))
    || new Set(rows.map(row => row[0])).size !== rows.length) fail('DOCUMENT_DECISIONS_INVALID');
  return rows.map(row => row[0]);
}

export function parseDesignDocument(markdown) {
  const { metadata, body } = frontmatter(markdown, ['kind', 'version', 'revision', 'status', 'slug', 'requestRevision']);
  if (metadata.kind !== 'design' || !positive(metadata.requestRevision)) fail('DOCUMENT_KIND_INVALID');
  const content = sections(body, ['Context', 'Chosen approach', 'Alternatives considered', 'Component diagram', 'Data-flow diagram',
    'Domain model', 'Storage model', 'External boundaries', 'Security and privacy', 'Failure modes', 'Verification strategy',
    'Rollout and rollback', 'Design decisions', 'Approval']);
  mermaid(content['Component diagram'], /^(?:flowchart|graph)\b/mu);
  mermaid(content['Data-flow diagram'], /^(?:sequenceDiagram|flowchart|graph)\b/mu);
  accepted(content.Approval);
  return { ...metadata, decisions: decisions(content['Design decisions']) };
}

function document(root, path, expected) {
  if (path !== expected) fail('DOCUMENT_PATH_INVALID');
  const full = resolve(root, path), rel = relative(root, full);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) fail('DOCUMENT_PATH_INVALID');
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 200000 || realpathSync(full) !== full) fail('DOCUMENT_PATH_INVALID');
  const tracked = spawnSync('git', ['--no-optional-locks', '-C', root, 'ls-files', '--error-unmatch', '--', rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const clean = spawnSync('git', ['--no-optional-locks', '-C', root, 'diff', '--quiet', 'HEAD', '--', rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (tracked.status !== 0 || clean.status !== 0) fail('DOCUMENT_NOT_COMMITTED');
  const bytes = readFileSync(full, 'utf8');
  let committed;
  try { committed = execFileSync('git', ['--no-optional-locks', '-C', root, 'show', `HEAD:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { fail('DOCUMENT_NOT_COMMITTED'); }
  if (committed !== bytes) fail('DOCUMENT_NOT_COMMITTED');
  return bytes;
}

export function bindDocuments({ root, requestPath, designPath }) {
  const request = parseRequestDocument(document(root, requestPath, requestPath));
  const expectedRequest = `docs/features/${request.slug}/request.md`, expectedDesign = `docs/features/${request.slug}/design.md`;
  if (requestPath !== expectedRequest) fail('DOCUMENT_PATH_INVALID');
  const design = parseDesignDocument(document(root, designPath, expectedDesign));
  if (design.slug !== request.slug || design.requestRevision !== request.revision) fail('DOCUMENT_PAIR_MISMATCH');
  const source = {
    ref: execFileSync('git', ['--no-optional-locks', '-C', root, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    sha: execFileSync('git', ['--no-optional-locks', '-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  };
  return validateScope({ version: 2, revision: design.revision, intent: request.intent, intentSource: request.intentSource,
    boundaries: request.boundaries.join('\n'), assumptions: request.assumptions, exclusions: request.exclusions,
    documents: { slug: request.slug, request: { path: requestPath, revision: request.revision },
      design: { path: designPath, revision: design.revision, requestRevision: design.requestRevision, decisions: design.decisions } },
    source, criteria: request.criteria });
}
