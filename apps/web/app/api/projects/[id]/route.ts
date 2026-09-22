import { deleteProject, getProject, updateProject } from '@/server/http';
import { getModelService } from '@/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return getProject((await context.params).id, getModelService());
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return updateProject((await context.params).id, request, getModelService());
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  return deleteProject((await context.params).id, getModelService());
}
