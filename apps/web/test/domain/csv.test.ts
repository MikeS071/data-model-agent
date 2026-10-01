import { describe, expect, it } from 'vitest';
import {
  analyzeCsvContent,
  csvProviderContext,
  decodeCsvBytes,
  distributedSampleIndexes,
} from '@/domain/csv';

const key = new Uint8Array(32).fill(7);
const options = { key, maskingGenerationId: 'generation-1', intakeSessionId: 'intake-1' };

describe('CSV analysis boundary', () => {
  it('parses UTF-8 BOM, quoting, embedded commas, escaped quotes and line breaks', () => {
    const content = decodeCsvBytes(new TextEncoder().encode(
      '\ufeffclaim_id,description,amount\r\n1,"Storm, ""major""\r\ndamage",10.50\r\n2,Minor,20\r\n',
    ));
    const analysis = analyzeCsvContent(content, options);

    expect(analysis.inferredHeaderMode).toBe('first-row');
    expect(analysis.headers).toEqual(['claim_id', 'description', 'amount']);
    expect(analysis.rowCount).toBe(2);
    expect(analysis.columns.map(column => column.inferredType)).toEqual(['integer', 'string', 'decimal']);
    expect(analysis.sampleRows[0].values[1]).toContain('Storm, "major"\ndamage');
  });

  it('requires review for headerless data and applies corrected headers on confirmation', () => {
    const draft = analyzeCsvContent('Alice,10\nBob,20\n', options);
    expect(draft.inferredHeaderMode).toBe('generated');
    expect(draft.headers).toEqual(['column_1', 'column_2']);
    expect(draft.confirmed).toBe(false);
    expect(draft.columns.every(column => column.sensitive && column.sensitivity.includes('headerless'))).toBe(true);
    expect(JSON.stringify(draft.sampleRows)).not.toContain('Alice');
    expect(JSON.stringify(draft.sampleRows)).not.toContain('Bob');

    const confirmed = analyzeCsvContent('Alice,10\nBob,20\n', {
      ...options,
      headerMode: 'generated',
      headers: ['customer_name', 'balance'],
      confirmed: true,
      now: () => '2026-10-01T00:00:00.000Z',
    });
    expect(confirmed.headers).toEqual(['customer_name', 'balance']);
    expect(confirmed.confirmedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('uses stable project-scoped pseudonyms while preventing cross-project correlation', () => {
    const content = 'customer_id,email,amount\n123,a@example.com,10\n123,a@example.com,20\n';
    const first = analyzeCsvContent(content, { ...options, confirmed: true });
    const sameProject = analyzeCsvContent(content, { ...options, intakeSessionId: null, confirmed: true });
    const otherProject = analyzeCsvContent(content, {
      ...options,
      key: new Uint8Array(32).fill(9),
      maskingGenerationId: 'generation-2',
      confirmed: true,
    });

    expect(first.sampleRows[0].values[0]).toBe(first.sampleRows[1].values[0]);
    expect(first.sampleRows[0].values[1]).toBe(first.sampleRows[1].values[1]);
    expect(sameProject.sampleRows[0].values).toEqual(first.sampleRows[0].values);
    expect(otherProject.sampleRows[0].values[0]).not.toBe(first.sampleRows[0].values[0]);
    expect(JSON.stringify(first)).not.toContain('a@example.com');
    expect(csvProviderContext('customers.csv', first)).not.toContain('a@example.com');
  });

  it('profiles the complete file while keeping unsampled sentinel values out of provider context', () => {
    const rowCount = 220;
    const sampled = new Set(distributedSampleIndexes(rowCount));
    const sentinelIndex = Array.from({ length: rowCount }, (_, index) => index).find(index => !sampled.has(index))!;
    const rows = Array.from({ length: rowCount }, (_, index) => {
      const sentinel = index === sentinelIndex;
      return [
        String(index + 1),
        sentinel ? '1.5' : '1',
        sentinel ? 'hidden@example.com' : 'ordinary',
        sentinel ? '' : 'present',
        sentinel ? 'different' : 'same',
        sentinel ? 'this-is-a-deliberately-long-unsampled-value' : 'x',
      ].join(',');
    });
    const content = `row_id,type_probe,format_probe,null_probe,unique_probe,length_probe\n${rows.join('\n')}\n`;
    const analysis = analyzeCsvContent(content, { ...options, confirmed: true });
    const byName = Object.fromEntries(analysis.columns.map(column => [column.name, column]));
    const providerContext = csvProviderContext('profile.csv', analysis);

    expect(analysis.sampleRows).toHaveLength(100);
    expect(byName.type_probe.inferredType).toBe('decimal');
    expect(byName.format_probe.formats).toContain('email');
    expect(byName.null_probe.nullRatio).toBeGreaterThan(0);
    expect(byName.unique_probe.uniqueRatio).toBeGreaterThan(1 / rowCount);
    expect(byName.length_probe.maxLength).toBeGreaterThan(20);
    expect(providerContext).not.toContain('hidden@example.com');
    expect(providerContext).not.toContain('this-is-a-deliberately-long-unsampled-value');
  });

  it('rejects invalid encoding, malformed input, inconsistent widths and invalid headers', () => {
    expect(() => decodeCsvBytes(Uint8Array.from([0xff, 0xfe]))).toThrow('csv-encoding-invalid');
    expect(() => analyzeCsvContent('a,b\n"unterminated,1\n', options)).toThrow('csv-malformed');
    expect(() => analyzeCsvContent('a,b\n1\n', options)).toThrow('csv-width-inconsistent');
    expect(() => analyzeCsvContent('a,b\n1,2\n', { ...options, headers: ['same', 'same'] })).toThrow('csv-header-invalid');
    expect(() => analyzeCsvContent(`${Array.from({ length: 251 }, (_, index) => `c${index}`).join(',')}\n${Array(251).fill('1').join(',')}\n`, options))
      .toThrow('csv-columns-exceeded');
    expect(() => analyzeCsvContent(`value\n${'1\n'.repeat(100_001)}`, options)).toThrow('csv-rows-exceeded');
  });
});
