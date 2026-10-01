import { normalizeSourceArtifacts } from '@/domain/input';
import { parseGenerationResult, parseRevisionResult } from '@/domain/model';
import type { GenerationResult, SourceArtifactInput } from '@/domain/model';
import type { ModelProvider } from '@/provider/model-provider';
import type { ProviderProgressHandler } from '@/provider/model-provider';
import { parseProviderSelection, parseProviderType } from '@/domain/provider-settings';
import type { ProviderSelection, ProviderSettings, ProviderType } from '@/domain/provider-settings';
import type { ModelVersion, ProjectRecord } from '@/storage/sqlite-repository';
import type { GenerationJobRequest } from '@/storage/sqlite-repository';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import type { ProviderDefaults, ProviderFactory, ProviderModelCatalog } from '@/server/providers';

export class ModelService {
  constructor(
    readonly repository: SqliteModelRepository,
    readonly provider: ModelProvider,
    readonly providerDefaults: ProviderSettings,
    readonly apiKeyConfigured: boolean,
    readonly providerType: ProviderType = 'openai',
    readonly providerDefaultsByType?: ProviderDefaults,
    readonly providerFactory?: ProviderFactory,
    readonly providerModelCatalog?: ProviderModelCatalog,
  ) {}

  getProviderSettings(requestedProviderType?: ProviderType) {
    const providerType = requestedProviderType
      ? parseProviderType(requestedProviderType)
      : this.repository.getDefaultProviderType(this.providerType);
    return { ...this.repository.getProviderSettings(this.#defaults(providerType), providerType), providerType, apiKeyConfigured: this.apiKeyConfigured };
  }

  saveProviderSettings(input: ProviderSettings & { providerType?: ProviderType }) {
    const providerType = input.providerType ? parseProviderType(input.providerType) : this.repository.getDefaultProviderType(this.providerType);
    const selection = this.repository.saveDefaultProvider(parseProviderSelection({ ...input, providerType }));
    return { ...selection, apiKeyConfigured: this.apiKeyConfigured };
  }

  async listProviderModels(providerType: ProviderType): Promise<Array<{ id: string; name: string }>> {
    const type = parseProviderType(providerType);
    const settings = this.repository.getProviderSettings(this.#defaults(type), type);
    return this.providerModelCatalog ? this.providerModelCatalog({ ...settings, providerType: type })
      : settings.model ? [{ id: settings.model, name: settings.model }] : [];
  }

  createProject(input: { title: string; requirements: string; sources: SourceArtifactInput[] }): ProjectRecord {
    const requirements = input.requirements.trim();
    if (!requirements) throw new Error('requirements-missing');
    return this.repository.createProject({
      title: input.title,
      requirements,
      sources: normalizeSourceArtifacts(input.sources),
      providerSettings: this.#defaultProviderSelection(),
    });
  }

  updateProject(projectId: string, input: {
    title: string;
    requirements: string;
    sources: SourceArtifactInput[];
    providerSettings?: ProviderSelection;
  }): ProjectRecord {
    const requirements = input.requirements.trim();
    if (!requirements) throw new Error('requirements-missing');
    const providerSettings = input.providerSettings ? parseProviderSelection(input.providerSettings) : this.#project(projectId).providerSettings!;
    return this.repository.updateProject(projectId, {
      title: input.title, requirements, sources: normalizeSourceArtifacts(input.sources), providerSettings,
    });
  }

  deleteProject(projectId: string): boolean { return this.repository.deleteProject(projectId); }

  async createAndGenerate(input: { title: string; requirements: string; sources: SourceArtifactInput[] }, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<ProjectRecord> {
    const project = this.createProject(input);
    const sources = project.sources.map(({ name, kind, content }) => ({ name, kind, content }));
    const provider = await this.#provider(project.providerSettings!);
    const result = parseGenerationResult(await provider.generate({ requirements: project.requirements, sources, currentModel: null, clarification: null }, onProgress, signal));
    onProgress?.({ phase: 'saving', message: 'Saving the validated working draft…' });
    this.repository.saveWorkingDraft(project.id, result);
    return this.repository.getProject(project.id)!;
  }

  async regenerate(projectId: string, clarification: string | null = null, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<ProjectRecord> {
    const project = this.#project(projectId);
    const sources = project.sources.map(({ name, kind, content }) => ({ name, kind, content }));
    const provider = await this.#provider(project.providerSettings!);
    const result = parseGenerationResult(await provider.generate({
      requirements: project.requirements, sources, currentModel: project.draft?.model ?? null,
      clarification: clarification?.trim() || null,
    }, onProgress, signal));
    onProgress?.({ phase: 'saving', message: 'Saving the validated working draft…' });
    this.repository.saveWorkingDraft(project.id, result);
    return this.repository.getProject(project.id)!;
  }

  async reviseFromChat(projectId: string, input: string, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<ProjectRecord> {
    const project = this.#project(projectId), message = input.trim();
    if (!project.draft) throw new Error('draft-missing');
    if (!message || message.length > 4_000) throw new Error('chat-message-invalid');
    const sources = project.sources.map(({ name, kind, content }) => ({ name, kind, content }));
    const history = project.messages.slice(-12).map(({ role, content }) => ({ role, content }));
    const provider = await this.#provider(project.providerSettings!);
    const revision = parseRevisionResult(await provider.revise({
      requirements: project.requirements, sources, currentModel: project.draft.model,
      clarification: project.draft.clarificationQuestions[0] ?? null, message, history,
    }, onProgress, signal));
    onProgress?.({ phase: 'saving', message: 'Saving the validated model revision…' });
    return this.repository.saveChatTurn(projectId, message, revision.assistantMessage, revision);
  }

  saveDraft(projectId: string, draft: GenerationResult): GenerationResult {
    if (!this.repository.getProject(projectId)) throw new Error('project-missing');
    return this.repository.saveWorkingDraft(projectId, draft);
  }

  prepareGeneration(projectId: string, clarification: string | null = null): {
    project: ProjectRecord;
    providerSettings: ProviderSelection;
    request: GenerationJobRequest;
  } {
    const project = this.#project(projectId);
    return {
      project,
      providerSettings: project.providerSettings!,
      request: {
        requirements: project.requirements,
        sources: project.sources.map(({ name, kind, content }) => ({ name, kind, content })),
        currentModel: project.draft?.model ?? null,
        clarification: clarification?.trim() || null,
      },
    };
  }

  saveProjectProviderSettings(projectId: string, input: ProviderSelection): ProjectRecord {
    this.repository.saveProjectProviderSettings(projectId, input);
    return this.#project(projectId);
  }

  saveVersion(projectId: string): ModelVersion { return this.repository.saveVersion(projectId); }
  continueFromVersion(projectId: string, versionNumber: number): GenerationResult { return this.repository.continueFromVersion(projectId, versionNumber); }
  getProject(projectId: string): ProjectRecord | null {
    const project = this.repository.getProject(projectId);
    return project ? this.#ensureProviderSettings(project) : null;
  }
  getVersion(projectId: string, versionNumber: number): ModelVersion | null { return this.repository.getVersion(projectId, versionNumber); }
  listProjects() { return this.repository.listProjects(); }

  #defaults(providerType: ProviderType) {
    return this.providerDefaultsByType?.[providerType] ?? this.providerDefaults;
  }

  #defaultProviderSelection(): ProviderSelection {
    const providerType = this.repository.getDefaultProviderType(this.providerType);
    return { ...this.repository.getProviderSettings(this.#defaults(providerType), providerType), providerType };
  }

  #ensureProviderSettings(project: ProjectRecord): ProjectRecord {
    if (project.providerSettings) return project;
    this.repository.saveProjectProviderSettings(project.id, this.#defaultProviderSelection());
    return this.repository.getProject(project.id)!;
  }

  #project(projectId: string): ProjectRecord {
    const project = this.getProject(projectId);
    if (!project) throw new Error('project-missing');
    return project;
  }

  #provider(selection: ProviderSelection): Promise<ModelProvider> {
    return this.providerFactory ? this.providerFactory(selection) : Promise.resolve(this.provider);
  }
}
