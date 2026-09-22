import { join, resolve } from 'node:path';
import { ModelService } from '@/application/model-service';
import type { ModelProvider } from '@/provider/model-provider';
import { OpenAIModelProvider } from '@/provider/openai-provider';
import { SqliteModelRepository } from '@/storage/sqlite-repository';

const globalState = globalThis as typeof globalThis & { __dataModelRepository?: SqliteModelRepository };

export function getModelService(): ModelService {
  const configured = process.env.DATA_MODEL_DB;
  const path = configured ? resolve(process.cwd(), configured) : join(process.cwd(), 'data/data-model-agent.db');
  const repository = globalState.__dataModelRepository ??= new SqliteModelRepository(path);
  const provider: ModelProvider = { generate: request => OpenAIModelProvider.fromEnvironment().generate(request) };
  return new ModelService(repository, provider);
}
