import type { GenerationResult, SourceArtifactInput } from '@/domain/model';
import { ModelService } from '@/application/model-service';

const publicErrors = new Set([
  'project-input-invalid', 'requirements-missing', 'sources-invalid', 'source-invalid', 'source-kind-unsupported',
  'source-binary', 'source-too-large', 'sources-too-large', 'project-missing', 'version-missing', 'draft-missing',
  'provider-not-configured', 'provider-timeout', 'provider-unavailable', 'provider-rate-limited', 'provider-failed',
  'provider-config-invalid', 'provider-output-missing', 'provider-output-invalid', 'provider-output-incomplete',
  'generation-result-invalid', 'revision-result-invalid', 'revision-message-invalid', 'chat-message-invalid', 'entities-invalid',
]);
const clientErrors = new Set(['project-input-invalid', 'requirements-missing', 'sources-invalid', 'source-invalid', 'source-kind-unsupported', 'source-binary', 'source-too-large', 'sources-too-large', 'chat-message-invalid']);

const errorResponse = (error: unknown) => {
  const candidate = error instanceof Error ? error.message : '';
  const code = publicErrors.has(candidate) ? candidate : 'request-failed';
  const status = clientErrors.has(code) ? 400 : code === 'project-missing' || code === 'version-missing' ? 404
    : code === 'provider-rate-limited' ? 429 : code === 'provider-not-configured' || code === 'provider-config-invalid' ? 503
      : code.startsWith('provider-') || code.startsWith('generation-') || code.startsWith('revision-') || code === 'entities-invalid' ? 502 : 500;
  return Response.json({ error: code }, { status });
};

async function json(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-request');
    return value as Record<string, unknown>;
  } catch { throw new Error('invalid-request'); }
}

export async function listProjects(service: ModelService) {
  try { return Response.json(service.listProjects()); } catch (error) { return errorResponse(error); }
}

export async function createProject(request: Request, service: ModelService) {
  try {
    const input = await json(request);
    const project = service.createProject({ title: input.title as string, requirements: input.requirements as string, sources: input.sources as SourceArtifactInput[] });
    return Response.json(project, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export function getProject(projectId: string, service: ModelService) {
  try {
    const project = service.getProject(projectId);
    return project ? Response.json(project) : Response.json({ error: 'project-missing' }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}

export async function updateProject(projectId: string, request: Request, service: ModelService) {
  try {
    const input = await json(request);
    return Response.json(service.updateProject(projectId, {
      title: input.title as string, requirements: input.requirements as string, sources: input.sources as SourceArtifactInput[],
    }));
  } catch (error) { return errorResponse(error); }
}

export function deleteProject(projectId: string, service: ModelService) {
  try {
    return service.deleteProject(projectId)
      ? new Response(null, { status: 204 })
      : Response.json({ error: 'project-missing' }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}

export async function generateDraft(projectId: string, request: Request, service: ModelService) {
  try {
    const input = await json(request);
    return Response.json(await service.regenerate(projectId, typeof input.clarification === 'string' ? input.clarification : null));
  } catch (error) { return errorResponse(error); }
}

export async function chatWithModel(projectId: string, request: Request, service: ModelService) {
  try {
    const input = await json(request);
    return Response.json(await service.reviseFromChat(projectId, typeof input.message === 'string' ? input.message : ''));
  } catch (error) { return errorResponse(error); }
}

export async function saveDraft(projectId: string, request: Request, service: ModelService) {
  try { return Response.json(service.saveDraft(projectId, await json(request) as unknown as GenerationResult)); }
  catch (error) { return errorResponse(error); }
}

export function saveVersion(projectId: string, service: ModelService) {
  try { return Response.json(service.saveVersion(projectId), { status: 201 }); }
  catch (error) { return errorResponse(error); }
}

export function getVersion(projectId: string, versionNumber: number, service: ModelService) {
  try {
    const version = service.getVersion(projectId, versionNumber);
    return version ? Response.json(version) : Response.json({ error: 'version-missing' }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}

export function continueVersion(projectId: string, versionNumber: number, service: ModelService) {
  try { return Response.json(service.continueFromVersion(projectId, versionNumber)); }
  catch (error) { return errorResponse(error); }
}

export function downloadVersion(projectId: string, versionNumber: number, format: string, service: ModelService) {
  try {
    const version = service.getVersion(projectId, versionNumber);
    if (!version) return Response.json({ error: 'version-missing' }, { status: 404 });
    if (format !== 'mermaid' && format !== 'drawio') return Response.json({ error: 'format-unsupported' }, { status: 400 });
    const project = service.getProject(projectId)!;
    const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'model';
    const contents = format === 'mermaid' ? version.mermaid : version.drawio;
    return new Response(contents, { headers: {
      'content-type': format === 'mermaid' ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}-v${versionNumber}.${format === 'mermaid' ? 'mmd' : 'drawio'}"`,
      'x-content-type-options': 'nosniff',
    } });
  } catch (error) { return errorResponse(error); }
}
