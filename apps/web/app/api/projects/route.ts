import { createProject, listProjects } from '@/server/http';
import { getModelService } from '@/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() { return listProjects(getModelService()); }
export async function POST(request: Request) { return createProject(request, getModelService()); }
