import type { GenerationResult, SourceArtifactInput } from '@/domain/model';
import { ModelService } from '@/application/model-service';
import type { ProviderProgress, ProviderProgressHandler } from '@/provider/model-provider';
import type { ProjectRecord } from '@/storage/sqlite-repository';
import { parseProviderSelection, parseProviderType } from '@/domain/provider-settings';
import type { GenerationJobManager } from '@/server/generation-jobs';
import type { GenerationJobRecord } from '@/storage/sqlite-repository';

const publicErrors = new Set([
  'project-input-invalid', 'requirements-missing', 'sources-invalid', 'source-invalid', 'source-kind-unsupported',
  'source-binary', 'source-too-large', 'sources-too-large', 'project-missing', 'version-missing', 'draft-missing',
  'provider-not-configured', 'provider-timeout', 'provider-unavailable', 'provider-rate-limited', 'provider-failed',
  'provider-config-invalid', 'provider-output-missing', 'provider-output-invalid', 'provider-output-incomplete',
  'generation-result-invalid', 'revision-result-invalid', 'revision-message-invalid', 'chat-message-invalid', 'entities-invalid',
  'provider-settings-invalid', 'generation-in-progress', 'generation-job-missing', 'generation-job-unavailable',
  'csv-encoding-invalid', 'csv-malformed', 'csv-empty', 'csv-columns-exceeded', 'csv-rows-exceeded',
  'csv-width-inconsistent', 'csv-header-invalid', 'csv-sensitive-columns-invalid', 'csv-analysis-required',
  'csv-confirmation-required', 'csv-confirmation-stale', 'csv-intake-session-expired', 'csv-masking-key-invalid',
  'database-schema-newer',
]);
const clientErrors = new Set([
  'project-input-invalid', 'requirements-missing', 'sources-invalid', 'source-invalid', 'source-kind-unsupported',
  'source-binary', 'source-too-large', 'sources-too-large', 'chat-message-invalid', 'provider-settings-invalid',
  'csv-encoding-invalid', 'csv-malformed', 'csv-empty', 'csv-columns-exceeded', 'csv-rows-exceeded',
  'csv-width-inconsistent', 'csv-header-invalid', 'csv-sensitive-columns-invalid', 'csv-analysis-required',
  'csv-confirmation-required', 'csv-confirmation-stale', 'csv-intake-session-expired',
]);

const errorCode = (error: unknown) => {
  const candidate = error instanceof Error ? error.message : '';
  return publicErrors.has(candidate) ? candidate : 'request-failed';
};

const errorResponse = (error: unknown) => {
  const code = errorCode(error);
  const status = clientErrors.has(code) ? 400 : code === 'project-missing' || code === 'version-missing' ? 404
    : code === 'generation-job-missing' ? 404
      : code === 'generation-in-progress' || code === 'generation-job-unavailable' ? 409
    : code === 'provider-rate-limited' ? 429 : code === 'provider-not-configured' || code === 'provider-config-invalid' ? 503
      : code.startsWith('provider-') || code.startsWith('generation-') || code.startsWith('revision-') || code === 'entities-invalid' ? 502 : 500;
  return Response.json({ error: code }, { status });
};

type ProjectStreamEvent =
  | { type: 'progress'; progress: ProviderProgress }
  | { type: 'result'; project: ProjectRecord }
  | { type: 'error'; error: string };

const publicGenerationJob = ({ request: _request, ...job }: GenerationJobRecord) => job;

function streamProject(operation: (onProgress: ProviderProgressHandler) => Promise<ProjectRecord>) {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: ProjectStreamEvent) => {
        if (open) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const close = () => {
        if (!open) return;
        open = false;
        controller.close();
      };
      void operation(progress => emit({ type: 'progress', progress })).then(project => {
        emit({ type: 'result', project });
        close();
      }).catch(error => {
        emit({ type: 'error', error: errorCode(error) });
        close();
      });
    },
    cancel() { open = false; },
  });
  return new Response(stream, { headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  } });
}

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

export function getProviderSettings(service: ModelService, request?: Request) {
  try {
    const requested = request ? new URL(request.url).searchParams.get('providerType') : null;
    return Response.json(service.getProviderSettings(requested ? parseProviderType(requested) : undefined));
  } catch (error) { return errorResponse(error); }
}

export async function saveProviderSettings(request: Request, service: ModelService) {
  try {
    const input = await json(request);
    return Response.json(service.saveProviderSettings({
      providerType: parseProviderType(input.providerType),
      baseUrl: input.baseUrl as string,
      model: input.model as string,
    }));
  } catch (error) { return errorResponse(error); }
}

export async function getProviderModels(request: Request, service: ModelService) {
  try {
    const providerType = parseProviderType(new URL(request.url).searchParams.get('providerType'));
    return Response.json(await service.listProviderModels(providerType));
  } catch (error) { return errorResponse(error); }
}

const formJson = <T>(form: FormData, name: string): T | undefined => {
  const value = form.get(name);
  if (typeof value !== 'string' || !value) return undefined;
  try { return JSON.parse(value) as T; }
  catch { throw new Error('invalid-request'); }
};

export async function analyzeCsv(request: Request, service: ModelService) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) throw new Error('invalid-request');
    const headerMode = form.get('headerMode');
    const projectId = form.get('projectId');
    const intakeSessionId = form.get('intakeSessionId');
    return Response.json(service.analyzeCsv({
      bytes: new Uint8Array(await file.arrayBuffer()),
      projectId: typeof projectId === 'string' && projectId ? projectId : undefined,
      intakeSessionId: typeof intakeSessionId === 'string' && intakeSessionId ? intakeSessionId : undefined,
      headerMode: headerMode === 'first-row' || headerMode === 'generated' ? headerMode : undefined,
      headers: formJson<string[]>(form, 'headers'),
      additionalSensitiveColumns: formJson<number[]>(form, 'additionalSensitiveColumns'),
      confirmed: form.get('confirmed') === 'true',
    }));
  } catch (error) { return errorResponse(error); }
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
      title: input.title as string,
      requirements: input.requirements as string,
      sources: input.sources as SourceArtifactInput[],
      providerSettings: input.providerSettings ? parseProviderSelection(input.providerSettings) : undefined,
    }));
  } catch (error) { return errorResponse(error); }
}

export async function createGenerationJob(
  projectId: string,
  request: Request,
  service: ModelService,
  manager: GenerationJobManager,
) {
  try {
    const input = await json(request);
    return Response.json(publicGenerationJob(manager.start(
      service,
      projectId,
      typeof input.clarification === 'string' ? input.clarification : null,
      typeof input.retryOfJobId === 'string' ? input.retryOfJobId : null,
    )), { status: 202 });
  } catch (error) { return errorResponse(error); }
}

export function getLatestGenerationJob(projectId: string, manager: GenerationJobManager) {
  try {
    const job = manager.latest(projectId);
    return job ? Response.json(publicGenerationJob(job)) : new Response(null, { status: 204 });
  } catch (error) { return errorResponse(error); }
}

export function getGenerationJob(jobId: string, manager: GenerationJobManager) {
  try { return Response.json(publicGenerationJob(manager.get(jobId))); }
  catch (error) { return errorResponse(error); }
}

export function cancelGenerationJob(jobId: string, manager: GenerationJobManager) {
  try { return Response.json(publicGenerationJob(manager.cancel(jobId))); }
  catch (error) { return errorResponse(error); }
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
    const clarification = typeof input.clarification === 'string' ? input.clarification : null;
    return request.headers.get('accept')?.includes('application/x-ndjson')
      ? streamProject(onProgress => service.regenerate(projectId, clarification, onProgress, request.signal))
      : Response.json(await service.regenerate(projectId, clarification));
  } catch (error) { return errorResponse(error); }
}

export async function chatWithModel(projectId: string, request: Request, service: ModelService) {
  try {
    const input = await json(request);
    const message = typeof input.message === 'string' ? input.message : '';
    return request.headers.get('accept')?.includes('application/x-ndjson')
      ? streamProject(onProgress => service.reviseFromChat(projectId, message, onProgress, request.signal))
      : Response.json(await service.reviseFromChat(projectId, message));
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
