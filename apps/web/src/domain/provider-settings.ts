export const DEFAULT_PROVIDER_BASE_URL = 'https://api.openai.com/v1';

export interface ProviderSettings {
  baseUrl: string;
  model: string;
}

export function normalizeProviderBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('provider-settings-invalid');
  const candidate = value.trim();
  if (!candidate || candidate.length > 2_048) throw new Error('provider-settings-invalid');
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error('provider-settings-invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('provider-settings-invalid');
  }
  return url.toString().replace(/\/+$/u, '');
}

export function parseProviderSettings(value: unknown): ProviderSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider-settings-invalid');
  const input = value as { baseUrl?: unknown; model?: unknown };
  if (typeof input.model !== 'string') throw new Error('provider-settings-invalid');
  const model = input.model.trim();
  if (!model || model.length > 200) throw new Error('provider-settings-invalid');
  return { baseUrl: normalizeProviderBaseUrl(input.baseUrl), model };
}
