import { getProviderModels } from '@/server/http';
import { getModelService } from '@/server/context';

export const runtime = 'nodejs';

export function GET(request: Request) {
  return getProviderModels(request, getModelService());
}
