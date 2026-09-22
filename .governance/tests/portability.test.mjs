import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const paths = JSON.parse(readFileSync(new URL('.governance/release-inputs.json', root)));
const word = (...codes) => String.fromCharCode(...codes);
const forbidden = [
  new RegExp(word(99, 111, 109, 112, 108, 101, 116, 101) + '[- ]?' + word(99, 111, 97, 99, 104), 'iu'),
  new RegExp(word(112, 115, 116, 97, 99, 107), 'iu'),
  new RegExp('\\b' + word(103, 108, 109) + '(?:\\b|[0-9_-])', 'iu'),
];

test('release inputs remain product and model neutral', () => {
  for (const path of paths) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(path, pattern, `branded release path: ${path}`);
      assert.doesNotMatch(readFileSync(new URL(path, root), 'utf8'), pattern, `branded release content: ${path}`);
    }
  }
});

test('third-party licence is retained and the worker example is inert', () => {
  const licence = readFileSync(new URL('.governance/LICENSE.third-party', root));
  assert.equal(createHash('sha256').update(licence).digest('hex'), 'bc957ca6bee02792566a1a028d105e02e247c6e77cf057061674273da77b200e');
  const example = readFileSync(new URL('.governance/worker/worker.config.toml.example', root), 'utf8');
  assert.match(example, /^model_provider = ""$/mu);
  assert.match(example, /^model = ""$/mu);
  assert.match(example, /https:\/\/api\.example\.invalid\/v1/u);
});
