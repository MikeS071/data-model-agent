import { describe, expect, it } from 'vitest';
import { normalizeSourceArtifacts } from '@/domain/input';

describe('source artifact boundary', () => {
  it('accepts and normalizes each requested text input form', () => {
    const actual = normalizeSourceArtifacts([
      { name: 'notes.txt', kind: 'text', content: 'free-form\r\nrequirements' },
      { name: 'model.md', kind: 'markdown', content: '# Existing model' },
      { name: 'schema.sql', kind: 'sql', content: 'CREATE TABLE claim(id UUID);' },
      { name: 'schema.ddl', kind: 'ddl', content: 'ALTER TABLE claim ADD amount DECIMAL;' },
      { name: 'schema.json', kind: 'json', content: '{"entity":"Claim"}' },
    ]);
    expect(actual.map(source => [source.kind, source.content])).toEqual([
      ['text', 'free-form\nrequirements'],
      ['markdown', '# Existing model'],
      ['sql', 'CREATE TABLE claim(id UUID);'],
      ['ddl', 'ALTER TABLE claim ADD amount DECIMAL;'],
      ['json', '{"entity":"Claim"}'],
    ]);
  });

  it('refuses binary, unsupported and oversized artifacts before provider access', () => {
    expect(() => normalizeSourceArtifacts([{ name: 'bad.exe', kind: 'text', content: 'MZ\0binary' }])).toThrow('source-binary');
    expect(() => normalizeSourceArtifacts([{ name: 'bad.csv', kind: 'csv' as 'text', content: 'a,b' }])).toThrow('source-kind-unsupported');
    expect(() => normalizeSourceArtifacts([{ name: 'large.txt', kind: 'text', content: 'x'.repeat(1_000_001) }])).toThrow('source-too-large');
  });
});
