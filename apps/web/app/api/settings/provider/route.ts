import { getModelService } from '@/server/context';
import { getProviderSettings, saveProviderSettings } from '@/server/http';

export const runtime = 'nodejs';

export function GET(request: Request) { return getProviderSettings(getModelService(), request); }
export function PUT(request: Request) { return saveProviderSettings(request, getModelService()); }
