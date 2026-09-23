import { getModelService } from '@/server/context';
import { getProviderSettings, saveProviderSettings } from '@/server/http';

export const runtime = 'nodejs';

export function GET() { return getProviderSettings(getModelService()); }
export function PUT(request: Request) { return saveProviderSettings(request, getModelService()); }
