import { saveVersion } from '@/server/http';
import { getModelService } from '@/server/context';

export const runtime = 'nodejs';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  return saveVersion((await context.params).id, getModelService());
}
