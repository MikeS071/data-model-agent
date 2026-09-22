import { basename, join } from 'node:path';
import { ModelService } from '@/application/model-service';
import type { ModelProvider } from '@/provider/model-provider';
import { OpenAIModelProvider } from '@/provider/openai-provider';
import { SqliteModelRepository } from '@/storage/sqlite-repository';

const globalState = globalThis as typeof globalThis & { __dataModelRepository?: SqliteModelRepository };

export function getModelService(): ModelService {
  const filename = basename(process.env.DATA_MODEL_DB_FILE ?? 'data-model-agent.db');
  const path = join(process.cwd(), 'data', filename);
  const repository = globalState.__dataModelRepository ??= new SqliteModelRepository(path);
  const provider: ModelProvider = { generate: request => OpenAIModelProvider.fromEnvironment().generate(request) };
  return new ModelService(repository, provider);
}
