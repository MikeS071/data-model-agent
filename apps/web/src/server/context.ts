import { basename, join } from 'node:path';
import { ModelService } from '@/application/model-service';
import type { ModelProvider } from '@/provider/model-provider';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import {
  configuredProviderType,
  createConfiguredProvider,
  listConfiguredProviderModels,
  providerDefaults,
} from '@/server/providers';
import { GenerationJobManager } from '@/server/generation-jobs';

const globalState = globalThis as typeof globalThis & {
  __dataModelRepository?: SqliteModelRepository;
  __generationJobManager?: GenerationJobManager;
};

export function getModelService(): ModelService {
  const filename = basename(process.env.DATA_MODEL_DB_FILE ?? 'data-model-agent.db');
  const path = join(process.cwd(), 'data', filename);
  const repository = globalState.__dataModelRepository ??= new SqliteModelRepository(path);
  const defaults = providerDefaults();
  let providerType: ReturnType<typeof configuredProviderType>;
  try { providerType = configuredProviderType(process.env.MODEL_PROVIDER); }
  catch { providerType = 'openai'; }
  const fallbackProvider: ModelProvider = {
    generate: async (request, onProgress, signal) => {
      const settings = repository.getProviderSettings(defaults[providerType], providerType);
      return (await createConfiguredProvider({ ...settings, providerType })).generate(request, onProgress, signal);
    },
    revise: async (request, onProgress, signal) => {
      const settings = repository.getProviderSettings(defaults[providerType], providerType);
      return (await createConfiguredProvider({ ...settings, providerType })).revise(request, onProgress, signal);
    },
  };
  return new ModelService(
    repository,
    fallbackProvider,
    defaults[providerType],
    Boolean(process.env.OPENAI_API_KEY),
    providerType,
    defaults,
    createConfiguredProvider,
    listConfiguredProviderModels,
  );
}

export function getGenerationJobManager() {
  const service = getModelService();
  return globalState.__generationJobManager ??= new GenerationJobManager(service.repository, createConfiguredProvider);
}
