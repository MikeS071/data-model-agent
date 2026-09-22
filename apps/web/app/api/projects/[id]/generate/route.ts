import { generateDraft } from '@/server/http';
import { getModelService } from '@/server/context';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return generateDraft((await context.params).id, request, getModelService());
}
