import { describe, expect, it } from 'vitest';
import {
  MAX_CSV_SOURCE_BYTES,
  MAX_NON_CSV_SOURCE_BYTES,
  MAX_TOTAL_SOURCE_BYTES,
  normalizeSourceArtifacts,
} from '@/domain/input';

describe('source artifact boundary', () => {
  it('accepts and normalizes each requested text input form', () => {
    const actual = normalizeSourceArtifacts([
      { name: 'notes.txt', kind: 'text', content: 'free-form\r\nrequirements' },
      { name: 'model.md', kind: 'markdown', content: '# Existing model' },
      { name: 'schema.sql', kind: 'sql', content: 'CREATE TABLE claim(id UUID);' },
      { name: 'schema.ddl', kind: 'ddl', content: 'ALTER TABLE claim ADD amount DECIMAL;' },
      { name: 'schema.json', kind: 'json', content: '{"entity":"Claim"}' },
      { name: 'claims.csv', kind: 'csv', content: 'claim_id,amount\n1,10.00' },
      { name: ' exact filename .csv ', kind: 'csv', content: 'value\n1' },
    ]);
    expect(actual.map(source => [source.kind, source.content])).toEqual([
      ['text', 'free-form\nrequirements'],
      ['markdown', '# Existing model'],
      ['sql', 'CREATE TABLE claim(id UUID);'],
      ['ddl', 'ALTER TABLE claim ADD amount DECIMAL;'],
      ['json', '{"entity":"Claim"}'],
      ['csv', 'claim_id,amount\n1,10.00'],
      ['csv', 'value\n1'],
    ]);
    expect(actual.at(-1)?.name).toBe(' exact filename .csv ');
  });

  it('refuses binary, unsupported and oversized artifacts before provider access', () => {
    expect(() => normalizeSourceArtifacts([{ name: 'bad.exe', kind: 'text', content: 'MZ\0binary' }])).toThrow('source-binary');
    expect(() => normalizeSourceArtifacts([{ name: 'bad.xml', kind: 'xml' as 'text', content: '<root />' }])).toThrow('source-kind-unsupported');
    expect(() => normalizeSourceArtifacts([{ name: 'large.txt', kind: 'text', content: 'x'.repeat(MAX_NON_CSV_SOURCE_BYTES + 1) }])).toThrow('source-too-large');
    expect(() => normalizeSourceArtifacts([{ name: 'large.csv', kind: 'csv', content: 'x'.repeat(MAX_CSV_SOURCE_BYTES + 1) }])).toThrow('source-too-large');
  });

  it('accepts exact per-file and aggregate limits and rejects one byte over', () => {
    const oneMegabyte = 'x'.repeat(MAX_NON_CSV_SOURCE_BYTES);
    const tenMegabytes = 'x'.repeat(MAX_CSV_SOURCE_BYTES);
    expect(normalizeSourceArtifacts([{ name: 'exact.txt', kind: 'text', content: oneMegabyte }])[0].content)
      .toHaveLength(MAX_NON_CSV_SOURCE_BYTES);
    expect(normalizeSourceArtifacts([{ name: 'exact.csv', kind: 'csv', content: tenMegabytes }])[0].content)
      .toHaveLength(MAX_CSV_SOURCE_BYTES);

    const exactAggregate = Array.from({ length: MAX_TOTAL_SOURCE_BYTES / MAX_CSV_SOURCE_BYTES }, (_, index) => ({
      name: `exact-${index}.csv`,
      kind: 'csv' as const,
      content: tenMegabytes,
    }));
    expect(normalizeSourceArtifacts(exactAggregate)).toHaveLength(5);
    expect(() => normalizeSourceArtifacts([
      ...exactAggregate,
      { name: 'one-byte.txt', kind: 'text', content: 'x' },
    ])).toThrow('sources-too-large');
  });
});
