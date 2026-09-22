import { describe, expect, it, vi } from 'vitest';
import { OpenAIModelProvider } from '@/provider/openai-provider';
import { claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

describe('OpenAI Responses boundary', () => {
  it('sends bounded sources server-side with structured output and returns parsed JSON', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(generatedClaimPayment) }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new OpenAIModelProvider({ apiKey: 'synthetic-secret', model: 'configured-model', fetcher, timeoutMs: 1000 });
    const actual = await provider.generate({ requirements: 'Model claim payments.', sources: claimSources, currentModel: null, clarification: null });
    expect(actual).toEqual(generatedClaimPayment);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init?.headers).toEqual({ Authorization: 'Bearer synthetic-secret', 'Content-Type': 'application/json' });
    expect([body.model, body.store, body.text.format.type, body.text.format.strict]).toEqual(['configured-model', false, 'json_schema', true]);
    expect(body.input).toContain('existing.ddl');
    expect(body.input).toContain('CREATE TABLE claim');
    expect(JSON.stringify(body)).not.toContain('synthetic-secret');
  });

  it('fails closed for missing configuration, provider errors and malformed output', async () => {
    expect(() => OpenAIModelProvider.fromEnvironment({})).toThrow('provider-not-configured');
    const failed = new OpenAIModelProvider({ apiKey: 'x', model: 'm', fetcher: async () => new Response('{}', { status: 429 }), timeoutMs: 1000 });
    await expect(failed.generate({ requirements: 'x', sources: [], currentModel: null, clarification: null })).rejects.toThrow('provider-rate-limited');
    const malformed = new OpenAIModelProvider({ apiKey: 'x', model: 'm', fetcher: async () => new Response(JSON.stringify({ output: [] }), { status: 200 }), timeoutMs: 1000 });
    await expect(malformed.generate({ requirements: 'x', sources: [], currentModel: null, clarification: null })).rejects.toThrow('provider-output-missing');
  });
});
