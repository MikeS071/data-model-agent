import { basename, join } from 'node:path';
import { ModelService } from '@/application/model-service';
import type { ModelProvider } from '@/provider/model-provider';
import { OpenAIModelProvider } from '@/provider/openai-provider';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import { DEFAULT_PROVIDER_BASE_URL } from '@/domain/provider-settings';

const globalState = globalThis as typeof globalThis & { __dataModelRepository?: SqliteModelRepository };

export function getModelService(): ModelService {
  const filename = basename(process.env.DATA_MODEL_DB_FILE ?? 'data-model-agent.db');
  const path = join(process.cwd(), 'data', filename);
  const repository = globalState.__dataModelRepository ??= new SqliteModelRepository(path);
  const defaults = {
    baseUrl: process.env.OPENAI_BASE_URL ?? DEFAULT_PROVIDER_BASE_URL,
    model: process.env.OPENAI_MODEL?.trim() ?? '',
  };
  const provider: ModelProvider = {
    generate: request => {
      const settings = repository.getProviderSettings(defaults);
      return OpenAIModelProvider.fromEnvironment({ ...process.env, OPENAI_BASE_URL: settings.baseUrl, OPENAI_MODEL: settings.model }).generate(request);
    },
    revise: request => {
      const settings = repository.getProviderSettings(defaults);
      return OpenAIModelProvider.fromEnvironment({ ...process.env, OPENAI_BASE_URL: settings.baseUrl, OPENAI_MODEL: settings.model }).revise(request);
    },
  };
  return new ModelService(repository, provider, defaults, Boolean(process.env.OPENAI_API_KEY));
}
