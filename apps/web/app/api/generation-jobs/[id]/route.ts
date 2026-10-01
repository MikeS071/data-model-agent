import { getGenerationJobManager } from '@/server/context';
import { cancelGenerationJob, getGenerationJob } from '@/server/http';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return getGenerationJob((await context.params).id, getGenerationJobManager());
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  return cancelGenerationJob((await context.params).id, getGenerationJobManager());
}
