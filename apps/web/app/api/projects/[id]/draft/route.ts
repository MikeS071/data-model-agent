import { saveDraft } from '@/server/http';
import { getModelService } from '@/server/context';

export const runtime = 'nodejs';

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return saveDraft((await context.params).id, request, getModelService());
}
