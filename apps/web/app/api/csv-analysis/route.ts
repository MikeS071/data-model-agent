import { analyzeCsv } from '@/server/http';
import { getModelService } from '@/server/context';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return analyzeCsv(request, getModelService());
}
