import type { SourceArtifactInput, SourceKind } from './model';

export const MAX_SOURCE_BYTES = 1_000_000;
export const MAX_TOTAL_SOURCE_BYTES = 5_000_000;
const kinds = new Set<SourceKind>(['text', 'markdown', 'sql', 'ddl', 'json', 'csv']);

export function normalizeSourceArtifacts(sources: SourceArtifactInput[]): SourceArtifactInput[] {
  if (!Array.isArray(sources)) throw new Error('sources-invalid');
  let total = 0;
  return sources.map(source => {
    if (!source || typeof source.name !== 'string' || source.name.trim().length === 0 || typeof source.content !== 'string') throw new Error('source-invalid');
    if (!kinds.has(source.kind)) throw new Error('source-kind-unsupported');
    if (source.content.includes('\0')) throw new Error('source-binary');
    const content = source.content.replace(/\r\n?/gu, '\n');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SOURCE_BYTES) throw new Error('source-too-large');
    total += bytes;
    if (total > MAX_TOTAL_SOURCE_BYTES) throw new Error('sources-too-large');
    if (source.kind !== 'csv' && source.csvAnalysis != null) throw new Error('source-invalid');
    return {
      name: source.name.trim(),
      kind: source.kind,
      content,
      ...(source.kind === 'csv' ? { csvAnalysis: source.csvAnalysis ?? null } : {}),
    };
  });
}
