import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const canonical = new URL('.governance/skills/ui-ux-pro-max/', root);
const router = readFileSync(new URL('.agents/skills/ui-ux-pro-max/SKILL.md', root), 'utf8');
const metadata = readFileSync(new URL('.agents/skills/ui-ux-pro-max/agents/openai.yaml', root), 'utf8');
const initializer = readFileSync(new URL('.agents/skills/dev-stack-project-initialisation/agents/openai.yaml', root), 'utf8');

test('UI skill is selectable but narrowly routed to visual and interactive work', () => {
  assert.match(router, /Select only for visual or interactive UI\/UX work/);
  for (const excluded of ['backend', 'API', 'database', 'infrastructure', 'non-visual']) {
    assert.match(router, new RegExp(excluded));
  }
  assert.match(metadata, /default_prompt:.*\$ui-ux-pro-max/);
  assert.match(metadata, /allow_implicit_invocation: true/);
});

test('project initialisation is selectable with guided one-question intake', () => {
  assert.match(initializer, /default_prompt:.*\$dev-stack-project-initialisation/);
  assert.match(initializer, /one critical unanswered question at a time/);
});

test('vendored UI catalog produces a local design-system recommendation', () => {
  const result = spawnSync('python3', [
    new URL('scripts/search.py', canonical).pathname,
    'insurance modelling workbench',
    '--design-system',
    '-p', 'Data Model Agent',
    '-f', 'markdown',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = result.stdout;
  assert.match(output, /Data Model Agent/);
  assert.match(output, /Color Palette|Typography|Design System/i);
  const provenance = readFileSync(new URL('UPSTREAM.md', canonical), 'utf8');
  assert.match(provenance, /2\.13\.0/);
  assert.match(provenance, /dcc40ff5133ef78276117db0cc34e7b83cc8aeba/);
});
