import { downloadVersion } from '@/server/http';
import { getModelService } from '@/server/context';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string; format: string }> }) {
  const { id, format } = await context.params;
  const version = Number(new URL(request.url).searchParams.get('version'));
  return downloadVersion(id, version, format, getModelService());
}
