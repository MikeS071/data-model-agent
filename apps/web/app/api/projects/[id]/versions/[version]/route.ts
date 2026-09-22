import { continueVersion, getVersion } from '@/server/http';
import { getModelService } from '@/server/context';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string; version: string }> };
export async function GET(_request: Request, context: Context) {
  const { id, version } = await context.params;
  return getVersion(id, Number(version), getModelService());
}
export async function POST(_request: Request, context: Context) {
  const { id, version } = await context.params;
  return continueVersion(id, Number(version), getModelService());
}
