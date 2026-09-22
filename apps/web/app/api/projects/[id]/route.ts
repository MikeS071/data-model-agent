import { getProject } from '@/server/http';
import { getModelService } from '@/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return getProject((await context.params).id, getModelService());
}
