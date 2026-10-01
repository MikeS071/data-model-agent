import { getGenerationJobManager, getModelService } from '@/server/context';
import { createGenerationJob, getLatestGenerationJob } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return createGenerationJob((await context.params).id, request, getModelService(), getGenerationJobManager());
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return getLatestGenerationJob((await context.params).id, getGenerationJobManager());
}
