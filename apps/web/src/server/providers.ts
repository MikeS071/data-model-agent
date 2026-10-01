import {
  DEFAULT_PROVIDER_BASE_URL,
  type ProviderSelection,
  type ProviderSettings,
  type ProviderType,
} from '@/domain/provider-settings';
import type { ModelProvider } from '@/provider/model-provider';
import { OpenAIModelProvider } from '@/provider/openai-provider';

export interface ProviderModelOption {
  id: string;
  name: string;
}

export type ProviderDefaults = Record<ProviderType, ProviderSettings>;
export type ProviderFactory = (selection: ProviderSelection) => Promise<ModelProvider>;
export type ProviderModelCatalog = (selection: ProviderSelection) => Promise<ProviderModelOption[]>;

export function providerDefaults(environment: Record<string, string | undefined> = process.env): ProviderDefaults {
  return {
    openai: {
      baseUrl: environment.OPENAI_BASE_URL ?? DEFAULT_PROVIDER_BASE_URL,
      model: environment.OPENAI_MODEL?.trim() ?? '',
    },
    'copilot-sdk': {
      baseUrl: DEFAULT_PROVIDER_BASE_URL,
      model: environment.COPILOT_MODEL?.trim() ?? '',
    },
    'vscode-agent-host': {
      baseUrl: DEFAULT_PROVIDER_BASE_URL,
      model: environment.VSCODE_AGENT_HOST_MODEL?.trim() ?? '',
    },
  };
}

export function configuredProviderType(value: string | undefined): ProviderType {
  if (!value || value === 'openai') return 'openai';
  if (value === 'copilot-sdk' || value === 'vscode-agent-host') return value;
  throw new Error('provider-config-invalid');
}

export const createConfiguredProvider: ProviderFactory = async selection => {
  if (selection.providerType === 'copilot-sdk') {
    const { CopilotModelProvider } = await import('@/provider/copilot-provider');
    return CopilotModelProvider.fromEnvironment({ ...process.env, COPILOT_MODEL: selection.model });
  }
  if (selection.providerType === 'vscode-agent-host') {
    const { VSCodeAgentHostProvider } = await import('@/provider/vscode-agent-host-provider');
    return VSCodeAgentHostProvider.fromEnvironment({ ...process.env, VSCODE_AGENT_HOST_MODEL: selection.model });
  }
  return OpenAIModelProvider.fromEnvironment({
    ...process.env,
    OPENAI_BASE_URL: selection.baseUrl,
    OPENAI_MODEL: selection.model,
  });
};

export const listConfiguredProviderModels: ProviderModelCatalog = async selection => {
  if (selection.providerType === 'vscode-agent-host') {
    const { VSCodeAgentHostProvider } = await import('@/provider/vscode-agent-host-provider');
    return VSCodeAgentHostProvider.fromEnvironment({ ...process.env, VSCODE_AGENT_HOST_MODEL: selection.model }).listModels();
  }
  return selection.model ? [{ id: selection.model, name: selection.model }] : [];
};
