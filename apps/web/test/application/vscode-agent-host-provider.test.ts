import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeRequest,
  type BridgeResponse,
} from '@data-model-agent/vscode-provider-protocol';
import { VSCodeAgentHostProvider } from '@/provider/vscode-agent-host-provider';
import { claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

function providerWith(response: BridgeResponse, model = 'gpt-5.6-sol') {
  const requests: BridgeRequest[] = [];
  const request = vi.fn(async (value: BridgeRequest, _connection: unknown, onEvent?: (event: {
    version: 2; id: string; event: 'progress'; phase: string; message: string;
  } | { version: 2; id: string; event: 'chunk'; text: string }) => void) => {
    requests.push(value);
    if (response.ok) {
      onEvent?.({ version: BRIDGE_PROTOCOL_VERSION, id: value.id, event: 'progress', phase: 'generating', message: 'Building the model…' });
      onEvent?.({ version: BRIDGE_PROTOCOL_VERSION, id: value.id, event: 'chunk', text: '{"model":' });
    }
    return response.ok ? { ...response, id: value.id } : { ...response, id: value.id };
  });
  const connection = {
    version: BRIDGE_PROTOCOL_VERSION,
    socketPath: '\\\\.\\pipe\\test-provider',
    token: 'a'.repeat(64),
  } as const;
  return {
    provider: new VSCodeAgentHostProvider({
      model,
      timeoutMs: 1000,
      connection: () => connection,
      request,
    }),
    requests,
  };
}

describe('VS Code language model bridge boundary', () => {
  it('discovers bridge models before a model is selected', async () => {
    const { provider, requests } = providerWith({
      version: BRIDGE_PROTOCOL_VERSION,
      id: 'placeholder',
      ok: true,
      result: { models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }] },
    }, '');

    await expect(provider.listModels()).resolves.toEqual([{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }]);
    expect(requests).toEqual([expect.objectContaining({ action: 'models' })]);
    await expect(provider.generate({
      requirements: 'x', sources: [], currentModel: null, clarification: null,
    })).rejects.toThrow('provider-not-configured');
  });

  it('sends a user-initiated, tool-free structured prompt and parses the JSON response', async () => {
    const { provider, requests } = providerWith({
      version: BRIDGE_PROTOCOL_VERSION,
      id: 'placeholder',
      ok: true,
      result: { text: JSON.stringify(generatedClaimPayment) },
    });
    const progress = vi.fn();
    const result = await provider.generate({
      requirements: 'Model claim payments.', sources: claimSources, currentModel: null, clarification: null,
    }, progress);

    expect(result).toEqual(generatedClaimPayment);
    expect(requests).toEqual([expect.objectContaining({
      version: BRIDGE_PROTOCOL_VERSION,
      action: 'complete',
      model: 'gpt-5.6-sol',
      token: 'a'.repeat(64),
      timeoutMs: 1000,
      userInitiated: true,
      prompt: expect.stringContaining('Do not call tools'),
    })]);
    expect((requests[0] as Extract<BridgeRequest, { action: 'complete' }>).prompt).toContain('existing.ddl');
    expect((requests[0] as Extract<BridgeRequest, { action: 'complete' }>).prompt).toContain('"additionalProperties":false');
    expect(progress).toHaveBeenCalledWith({ phase: 'generating', message: 'Building the model…' });
    expect(progress).toHaveBeenCalledWith({
      phase: 'receiving', message: 'Receiving live model output…', transcriptDelta: '{"model":',
    });
  });

  it.each([
    ['no-permissions', 'provider-not-configured'],
    ['not-found', 'provider-config-invalid'],
    ['blocked', 'provider-rate-limited'],
    ['timeout', 'provider-timeout'],
    ['request-too-large', 'provider-config-invalid'],
    ['response-invalid', 'provider-output-invalid'],
    ['request-failed', 'provider-unavailable'],
  ] as const)('maps bridge error %s to %s', async (bridgeError, providerError) => {
    const { provider } = providerWith({
      version: BRIDGE_PROTOCOL_VERSION,
      id: 'placeholder',
      ok: false,
      error: bridgeError,
    });
    await expect(provider.generate({
      requirements: 'x', sources: [], currentModel: null, clarification: null,
    })).rejects.toThrow(providerError);
  });

  it('accepts a single JSON fence but rejects surrounding prose', async () => {
    const { provider } = providerWith({
      version: BRIDGE_PROTOCOL_VERSION,
      id: 'placeholder',
      ok: true,
      result: { text: '```json\n{}\n```' },
    });
    await expect(provider.generate({
      requirements: 'x', sources: [], currentModel: null, clarification: null,
    })).resolves.toEqual({});

    const prose = providerWith({
      version: BRIDGE_PROTOCOL_VERSION,
      id: 'placeholder',
      ok: true,
      result: { text: 'Here is the result: {}' },
    }).provider;
    await expect(prose.generate({
      requirements: 'x', sources: [], currentModel: null, clarification: null,
    })).rejects.toThrow('provider-output-invalid');
  });
});
