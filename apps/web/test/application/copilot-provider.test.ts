import { describe, expect, it, vi } from 'vitest';
import type { GetAuthStatusResponse, MessageOptions, ModelInfo, ResponseSchema, SessionConfig } from '@github/copilot-sdk';
import { CopilotModelProvider, type CopilotClientLike } from '@/provider/copilot-provider';
import { claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

function harness(options: { authenticated?: boolean; models?: Partial<ModelInfo>[]; result?: unknown; failure?: Error } = {}) {
  const sendCalls: Array<{ message: MessageOptions | string; schema: Record<string, unknown>; timeout?: number }> = [];
  const session = {
    sessionId: 'session-1',
    async sendAndWait<T>(message: MessageOptions | string, schema: ResponseSchema<T>, timeout?: number): Promise<T> {
      sendCalls.push({ message, schema: schema.toJSONSchema(), timeout });
      if (options.failure) throw options.failure;
      return schema.parse(options.result ?? generatedClaimPayment);
    },
    disconnect: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  const client: CopilotClientLike = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => []),
    getAuthStatus: vi.fn(async (): Promise<GetAuthStatusResponse> => ({ isAuthenticated: options.authenticated ?? true, authType: 'user' })),
    listModels: vi.fn(async () => (options.models ?? [{
      id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol',
      capabilities: { supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 922_000 } },
      supportedReasoningEfforts: ['high', 'xhigh'],
    }]) as ModelInfo[]),
    createSession: vi.fn(async (_config: SessionConfig) => session),
    deleteSession: vi.fn(async () => undefined),
  };
  const provider = new CopilotModelProvider({
    model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', timeoutMs: 1_000, clientFactory: () => client,
  });
  return { client, provider, sendCalls, session };
}

describe('GitHub Copilot SDK boundary', () => {
  it('uses structured output with no tools and deletes the isolated session', async () => {
    const { client, provider, sendCalls, session } = harness();
    const result = await provider.generate({
      requirements: 'Model claim payments.', sources: claimSources, currentModel: null, clarification: null,
    });

    expect(result).toEqual(generatedClaimPayment);
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      systemMessage: expect.objectContaining({ content: expect.stringContaining('conservative data-model draft') }),
      availableTools: [],
      tools: [],
      enableConfigDiscovery: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
      remoteSession: 'off',
    }));
    const sessionConfig = vi.mocked(client.createSession).mock.calls[0][0];
    expect(await sessionConfig.onPermissionRequest?.({
      kind: 'custom-tool', toolName: 'unsafe', toolDescription: 'An unavailable tool',
    }, { sessionId: 'session-1' })).toEqual({
      kind: 'reject', feedback: 'Tool use is disabled for data-model generation.',
    });
    expect(sendCalls).toEqual([expect.objectContaining({
      message: expect.objectContaining({ prompt: expect.stringContaining('existing.ddl') }),
      schema: expect.objectContaining({ type: 'object' }),
      timeout: 1_000,
    })]);
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(client.deleteSession).toHaveBeenCalledWith('session-1');
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it('fails closed when OAuth is missing or the selected model is unavailable', async () => {
    const unauthenticated = harness({ authenticated: false });
    await expect(unauthenticated.provider.generate({
      requirements: 'x', sources: [], currentModel: null, clarification: null,
    })).rejects.toThrow('provider-not-configured');

    const unavailable = harness({ models: [] });
    await expect(unavailable.provider.generate({
      requirements: 'x', sources: [], currentModel: null, clarification: null,
    })).rejects.toThrow('provider-config-invalid');
  });

  it('maps SDK timeouts without exposing source content', async () => {
    const { client, provider, session } = harness({ failure: new Error('Request timed out while waiting for session.idle') });
    await expect(provider.generate({
      requirements: 'PRIVATE-MARKER', sources: [], currentModel: null, clarification: null,
    })).rejects.toThrow('provider-timeout');
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(client.deleteSession).toHaveBeenCalledWith('session-1');
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it('maps generic SDK failures to provider unavailable and still stops the client', async () => {
    const { client, provider } = harness({ failure: new Error('runtime connection closed') });
    await expect(provider.generate({
      requirements: 'x', sources: [], currentModel: null, clarification: null,
    })).rejects.toThrow('provider-unavailable');
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it('aborts a session created after cancellation during provider setup', async () => {
    const { client, provider, sendCalls, session } = harness();
    type Session = Awaited<ReturnType<CopilotClientLike['createSession']>>;
    let resolveSession!: (session: Session) => void;
    vi.mocked(client.createSession).mockImplementation(() => new Promise<Session>(resolve => { resolveSession = resolve; }));
    const controller = new AbortController();
    const completion = provider.generate({
      requirements: 'x', sources: [], currentModel: null, clarification: null,
    }, undefined, controller.signal);

    await vi.waitFor(() => expect(client.createSession).toHaveBeenCalledOnce());
    controller.abort();
    resolveSession(session);

    await expect(completion).rejects.toThrow('provider-unavailable');
    expect(session.abort).toHaveBeenCalledOnce();
    expect(sendCalls).toEqual([]);
    expect(client.deleteSession).toHaveBeenCalledWith('session-1');
  });
});
