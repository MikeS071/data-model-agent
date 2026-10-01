import { createHash, createHmac } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import type {
  CsvAnalysis,
  CsvColumnProfile,
  CsvHeaderMode,
  CsvInferredType,
  CsvSampleRow,
} from './model';
import { MAX_SOURCE_BYTES } from './input';

export const CSV_ANALYSIS_VERSION = 1;
export const MAX_CSV_ROWS = 100_000;
export const MAX_CSV_COLUMNS = 250;
export const MAX_CSV_SAMPLE_ROWS = 100;

export interface CsvAnalysisOptions {
  key: Uint8Array;
  maskingGenerationId: string;
  intakeSessionId?: string | null;
  headerMode?: CsvHeaderMode;
  headers?: string[];
  additionalSensitiveColumns?: number[];
  confirmed?: boolean;
  now?: () => string;
}

const normalizedName = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '');
const nonEmpty = (value: string) => value.trim().length > 0;
const booleanPattern = /^(?:true|false|yes|no|y|n)$/iu;
const integerPattern = /^[+-]?\d+$/u;
const decimalPattern = /^[+-]?(?:\d+\.\d+|\d+\.\d*|\.\d+)$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/u;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const phonePattern = /^\+?(?:[\d][\s().-]?){7,15}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const urlPattern = /^https?:\/\/\S+$/iu;

export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('source-too-large');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('csv-encoding-invalid'); }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  if (content.includes('\0')) throw new Error('source-binary');
  return content.replace(/\r\n?/gu, '\n');
}

function valueType(value: string): CsvInferredType {
  const text = value.trim();
  if (!text) return 'empty';
  if (booleanPattern.test(text)) return 'boolean';
  if (integerPattern.test(text)) return 'integer';
  if (decimalPattern.test(text)) return 'decimal';
  if (dateTimePattern.test(text)) return 'datetime';
  if (datePattern.test(text)) return 'date';
  return 'string';
}

function inferredType(values: string[]): CsvInferredType {
  const types = new Set(values.map(valueType).filter(type => type !== 'empty'));
  if (!types.size) return 'empty';
  if (types.size === 1) return [...types][0];
  if ([...types].every(type => type === 'integer' || type === 'decimal')) return 'decimal';
  if ([...types].every(type => type === 'date' || type === 'datetime')) return 'datetime';
  return 'string';
}

function luhn(value: string) {
  const digits = value.replace(/\D/gu, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let total = 0;
  for (let index = digits.length - 1, alternate = false; index >= 0; index -= 1, alternate = !alternate) {
    let digit = Number(digits[index]);
    if (alternate && (digit *= 2) > 9) digit -= 9;
    total += digit;
  }
  return total % 10 === 0;
}

function formats(values: string[]) {
  const detected = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    if (emailPattern.test(value)) detected.add('email');
    if (phonePattern.test(value)) detected.add('phone');
    if (uuidPattern.test(value)) detected.add('uuid');
    if (urlPattern.test(value)) detected.add('url');
    if (datePattern.test(value)) detected.add('iso-date');
    if (dateTimePattern.test(value)) detected.add('iso-datetime');
    if (luhn(value)) detected.add('payment-card');
  }
  return [...detected].sort();
}

function sensitivity(name: string, values: string[], detectedFormats: string[]) {
  const normalized = normalizedName(name);
  const categories = new Set<string>();
  if (/(?:^|_)(?:full_?)?name(?:_|$)|first_name|last_name|surname/iu.test(normalized)) categories.add('name');
  if (/email/iu.test(normalized) || detectedFormats.includes('email')) categories.add('email');
  if (/phone|mobile|telephone/iu.test(normalized) || detectedFormats.includes('phone')) categories.add('phone');
  if (/address|street|suburb|postcode|postal/iu.test(normalized)) categories.add('address');
  if (/date_of_birth|birth_date|dob/iu.test(normalized)) categories.add('birth-date');
  if (/(?:^|_)(?:id|identifier|account|member|customer|claim|policy|licen[cs]e|vin|reference|number|no)(?:_|$)/iu.test(normalized)
    || detectedFormats.includes('uuid')) categories.add('identifier');
  if (/card|pan/iu.test(normalized) || detectedFormats.includes('payment-card') || values.some(luhn)) categories.add('payment-card');
  return [...categories].sort();
}

function inferHeaderMode(rows: string[][]): CsvHeaderMode {
  const first = rows[0] ?? [];
  if (!first.length || first.some(value => !nonEmpty(value))) return 'generated';
  const normalized = first.map(normalizedName);
  if (new Set(normalized).size !== normalized.length) return 'generated';
  const knownHeader = normalized.some(value => /name|email|phone|address|date|status|amount|type|code|id|number|reference/iu.test(value));
  const typeDifference = first.some((value, index) => {
    const later = rows.slice(1, 21).map(row => row[index] ?? '');
    return valueType(value) === 'string' && inferredType(later) !== 'string' && inferredType(later) !== 'empty';
  });
  return knownHeader || typeDifference ? 'first-row' : 'generated';
}

function normalizedHeaders(values: string[] | undefined, columnCount: number, mode: CsvHeaderMode, first: string[]) {
  const defaults = mode === 'first-row'
    ? first.map((value, index) => value.trim() || `column_${index + 1}`)
    : Array.from({ length: columnCount }, (_, index) => `column_${index + 1}`);
  const headers = values ?? defaults;
  if (headers.length !== columnCount || headers.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('csv-header-invalid');
  }
  const trimmed = headers.map(value => value.trim());
  if (new Set(trimmed.map(value => value.toLowerCase())).size !== trimmed.length) throw new Error('csv-header-invalid');
  return trimmed;
}

export function distributedSampleIndexes(rowCount: number, maximum = MAX_CSV_SAMPLE_ROWS) {
  if (rowCount <= 0) return [];
  if (rowCount <= maximum) return Array.from({ length: rowCount }, (_, index) => index);
  const indexes = new Set<number>();
  for (let index = 0; index < maximum; index += 1) {
    indexes.add(Math.round(index * (rowCount - 1) / (maximum - 1)));
  }
  return [...indexes].sort((left, right) => left - right);
}

function pseudonym(key: Uint8Array, value: string) {
  const digest = createHmac('sha256', key).update(value).digest('base64url').slice(0, 12);
  return `<masked:${digest}>`;
}

export function analyzeCsvContent(content: string, options: CsvAnalysisOptions): CsvAnalysis {
  let rows: string[][];
  let parsedRows = 0;
  let parsedColumns: number | null = null;
  try {
    rows = parse(content, {
      bom: true,
      columns: false,
      delimiter: ',',
      relax_column_count: true,
      skip_empty_lines: true,
      max_record_size: MAX_SOURCE_BYTES,
      on_record(record: string[]) {
        parsedRows += 1;
        if (parsedRows > MAX_CSV_ROWS + 1) throw new Error('csv-rows-exceeded');
        if (record.length > MAX_CSV_COLUMNS) throw new Error('csv-columns-exceeded');
        parsedColumns ??= record.length;
        if (record.length !== parsedColumns) throw new Error('csv-width-inconsistent');
        return record;
      },
    }) as string[][];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('csv-')) throw error;
    throw new Error('csv-malformed');
  }
  if (!rows.length || !rows[0]?.length) throw new Error('csv-empty');
  const columnCount = rows[0].length;
  if (columnCount > MAX_CSV_COLUMNS) throw new Error('csv-columns-exceeded');
  if (rows.some(row => row.length !== columnCount)) throw new Error('csv-width-inconsistent');
  const inferredHeaderMode = inferHeaderMode(rows);
  const headerMode = options.headerMode ?? inferredHeaderMode;
  const headers = normalizedHeaders(options.headers, columnCount, headerMode, rows[0]);
  const dataRows = headerMode === 'first-row' ? rows.slice(1) : rows;
  if (!dataRows.length) throw new Error('csv-empty');
  if (dataRows.length > MAX_CSV_ROWS) throw new Error('csv-rows-exceeded');
  const manualSensitive = new Set(options.additionalSensitiveColumns ?? []);
  if ([...manualSensitive].some(index => !Number.isSafeInteger(index) || index < 0 || index >= columnCount)) {
    throw new Error('csv-sensitive-columns-invalid');
  }
  const columns: CsvColumnProfile[] = headers.map((name, index) => {
    const values = dataRows.map(row => row[index] ?? '');
    const populated = values.filter(nonEmpty);
    const detectedFormats = formats(populated);
    const detectedSensitivity = sensitivity(name, populated, detectedFormats);
    if (headerMode === 'generated') detectedSensitivity.push('headerless');
    if (manualSensitive.has(index)) detectedSensitivity.push('manual');
    const lengths = populated.map(value => value.length);
    return {
      index,
      name,
      inferredType: inferredType(values),
      nullable: populated.length !== values.length,
      nullRatio: values.length ? (values.length - populated.length) / values.length : 0,
      uniqueRatio: populated.length ? new Set(populated).size / populated.length : 0,
      minLength: lengths.length ? Math.min(...lengths) : 0,
      maxLength: lengths.length ? Math.max(...lengths) : 0,
      formats: detectedFormats,
      sensitive: detectedSensitivity.length > 0,
      sensitivity: [...new Set(detectedSensitivity)].sort(),
    };
  });
  const sampleRows: CsvSampleRow[] = distributedSampleIndexes(dataRows.length).map(rowIndex => ({
    rowIndex,
    values: dataRows[rowIndex].map((value, columnIndex) => {
      const profile = columns[columnIndex];
      if (!value || !profile.sensitive) return value;
      return pseudonym(options.key, value);
    }),
  }));
  return {
    analysisVersion: CSV_ANALYSIS_VERSION,
    contentDigest: createHash('sha256').update(content).digest('hex'),
    maskingGenerationId: options.maskingGenerationId,
    intakeSessionId: options.intakeSessionId ?? null,
    inferredHeaderMode,
    headerMode,
    headers,
    rowCount: dataRows.length,
    columnCount,
    columns,
    sampleRows,
    additionalSensitiveColumns: [...manualSensitive].sort((left, right) => left - right),
    confirmed: options.confirmed ?? false,
    confirmedAt: options.confirmed ? (options.now ?? (() => new Date().toISOString()))() : null,
  };
}

export function csvProviderContext(name: string, analysis: CsvAnalysis) {
  if (!analysis.confirmed || analysis.analysisVersion !== CSV_ANALYSIS_VERSION) throw new Error('csv-confirmation-required');
  return [
    `CSV source: ${name}`,
    `Content digest: ${analysis.contentDigest}`,
    `Analysis version: ${analysis.analysisVersion}; masking generation: ${analysis.maskingGenerationId}`,
    `Rows: ${analysis.rowCount}; columns: ${analysis.columnCount}; header mode: ${analysis.headerMode}`,
    `Columns:\n${JSON.stringify(analysis.columns)}`,
    `Masked distributed sample rows:\n${JSON.stringify(analysis.sampleRows)}`,
  ].join('\n');
}
