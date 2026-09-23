import { describe, expect, it, vi } from 'vitest';
import { OpenAIModelProvider } from '@/provider/openai-provider';
import { claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

describe('OpenAI Responses boundary', () => {
  it('sends bounded sources server-side with structured output and returns parsed JSON', async () => {
    const diagnostics: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(generatedClaimPayment) }] }],
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'request-123' } }));
    const provider = new OpenAIModelProvider({
      apiKey: 'synthetic-secret', baseUrl: 'https://models.example.test/api/v1/', model: 'configured-model', fetcher, timeoutMs: 1000,
      reasoningEffort: 'low', maxOutputTokens: 8000, diagnostics: event => diagnostics.push(event),
    });
    const actual = await provider.generate({ requirements: 'Model claim payments.', sources: claimSources, currentModel: null, clarification: null });
    expect(actual).toEqual(generatedClaimPayment);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe('https://models.example.test/api/v1/responses');
    expect(init?.headers).toEqual({ Authorization: 'Bearer synthetic-secret', 'Content-Type': 'application/json' });
    expect([
      body.model, body.store, body.reasoning.effort, body.max_output_tokens,
      body.text.format.type, body.text.format.strict,
    ]).toEqual(['configured-model', false, 'low', 8000, 'json_schema', true]);
    expect(body.input).toContain('existing.ddl');
    expect(body.input).toContain('CREATE TABLE claim');
    expect(JSON.stringify(body)).not.toContain('synthetic-secret');
    expect(diagnostics).toEqual([expect.objectContaining({
      outcome: 'completed', model: 'configured-model', reasoningEffort: 'low',
      maxOutputTokens: 8000, timeoutMs: 1000, status: 200, requestId: 'request-123',
      durationMs: expect.any(Number),
    })]);
    expect(JSON.stringify(diagnostics)).not.toContain('Model claim payments.');
    expect(JSON.stringify(diagnostics)).not.toContain('synthetic-secret');
  });

  it('loads bounded defaults and operator overrides from the server environment', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const diagnostics: Array<{ timeoutMs: number }> = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(generatedClaimPayment) }] }] });
    });
    const request = { requirements: 'x', sources: [], currentModel: null, clarification: null };
    await OpenAIModelProvider.fromEnvironment(
      { OPENAI_API_KEY: 'x', OPENAI_MODEL: 'm' },
      { fetcher, diagnostics: event => diagnostics.push(event) },
    ).generate(request);
    await OpenAIModelProvider.fromEnvironment({
      OPENAI_API_KEY: 'x', OPENAI_BASE_URL: 'https://compatible.example/v1', OPENAI_MODEL: 'm', OPENAI_TIMEOUT_MS: '90000',
      OPENAI_REASONING_EFFORT: 'medium', OPENAI_MAX_OUTPUT_TOKENS: '12000',
    }, { fetcher, diagnostics: event => diagnostics.push(event) }).generate(request);
    expect(calls.map(call => [(call.body.reasoning as { effort: string }).effort, call.body.max_output_tokens])).toEqual([
      ['low', 8000], ['medium', 12000],
    ]);
    expect(calls.map(call => call.url)).toEqual([
      'https://api.openai.com/v1/responses', 'https://compatible.example/v1/responses',
    ]);
    expect(diagnostics.map(event => event.timeoutMs)).toEqual([120_000, 90_000]);
  });

  it('fails closed for missing or invalid configuration, timeouts and incomplete output', async () => {
    expect(() => OpenAIModelProvider.fromEnvironment({})).toThrow('provider-not-configured');
    for (const environment of [
      { OPENAI_API_KEY: 'x', OPENAI_MODEL: 'm', OPENAI_TIMEOUT_MS: '0' },
      { OPENAI_API_KEY: 'x', OPENAI_MODEL: 'm', OPENAI_MAX_OUTPUT_TOKENS: 'many' },
      { OPENAI_API_KEY: 'x', OPENAI_MODEL: 'm', OPENAI_REASONING_EFFORT: 'fast' },
      { OPENAI_API_KEY: 'x', OPENAI_MODEL: 'm', OPENAI_BASE_URL: 'ftp://models.example/v1' },
      { OPENAI_API_KEY: 'x', OPENAI_MODEL: 'm', OPENAI_BASE_URL: 'https://user:secret@models.example/v1' },
    ]) expect(() => OpenAIModelProvider.fromEnvironment(environment)).toThrow('provider-config-invalid');

    const diagnostics: unknown[] = [];
    const timedOut = new OpenAIModelProvider({
      apiKey: 'x', model: 'm', fetcher: async () => { throw new DOMException('timed out', 'TimeoutError'); },
      timeoutMs: 1000, diagnostics: event => diagnostics.push(event),
    });
    await expect(timedOut.generate({ requirements: 'PRIVATE-MARKER', sources: [], currentModel: null, clarification: null })).rejects.toThrow('provider-timeout');
    expect(diagnostics).toEqual([expect.objectContaining({ outcome: 'timeout', status: null, requestId: null })]);
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE-MARKER');

    const incomplete = new OpenAIModelProvider({
      apiKey: 'x', model: 'm', fetcher: async () => Response.json({
        status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
      }), diagnostics: () => undefined,
    });
    await expect(incomplete.generate({ requirements: 'x', sources: [], currentModel: null, clarification: null })).rejects.toThrow('provider-output-incomplete');
  });

  it('preserves typed provider and malformed-output failures', async () => {
    const failed = new OpenAIModelProvider({ apiKey: 'x', model: 'm', fetcher: async () => new Response('{}', { status: 429 }), timeoutMs: 1000, diagnostics: () => undefined });
    await expect(failed.generate({ requirements: 'x', sources: [], currentModel: null, clarification: null })).rejects.toThrow('provider-rate-limited');
    const malformed = new OpenAIModelProvider({ apiKey: 'x', model: 'm', fetcher: async () => new Response(JSON.stringify({ output: [] }), { status: 200 }), timeoutMs: 1000, diagnostics: () => undefined });
    await expect(malformed.generate({ requirements: 'x', sources: [], currentModel: null, clarification: null })).rejects.toThrow('provider-output-missing');
  });

  it('requests a structured assistant reply and complete revised model for chat', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        ...generatedClaimPayment, assistantMessage: 'I added recovery transactions.',
      }) }] }],
    }));
    const provider = new OpenAIModelProvider({ apiKey: 'x', model: 'm', fetcher, diagnostics: () => undefined });
    const result = await provider.revise({
      requirements: 'Model claims.', sources: claimSources, currentModel: generatedClaimPayment.model,
      clarification: 'Should an external payment reference be unique?',
      message: 'Yes, within the payment platform.', history: [],
    });
    expect(result).toEqual({ ...generatedClaimPayment, assistantMessage: 'I added recovery transactions.' });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.text.format.name).toBe('data_model_revision');
    expect(body.input).toContain('Should an external payment reference be unique?');
    expect(body.input).toContain('Yes, within the payment platform.');
    expect(body.input).toContain('Claim Payment');
  });
});
