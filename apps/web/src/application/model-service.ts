import { normalizeSourceArtifacts } from '@/domain/input';
import { analyzeCsvContent, csvProviderContext, decodeCsvBytes } from '@/domain/csv';
import { parseGenerationResult, parseRevisionResult } from '@/domain/model';
import type { CsvAnalysis, CsvHeaderMode, GenerationResult, ProviderSourceInput, SourceArtifactInput } from '@/domain/model';
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

  analyzeCsv(input: {
    bytes: Uint8Array;
    projectId?: string;
    intakeSessionId?: string | null;
    headerMode?: CsvHeaderMode;
    headers?: string[];
    additionalSensitiveColumns?: number[];
    confirmed?: boolean;
  }): { content: string; analysis: CsvAnalysis } {
    const content = decodeCsvBytes(input.bytes);
    const context = this.repository.getCsvMaskingContext({
      projectId: input.projectId,
      intakeSessionId: input.intakeSessionId,
    });
    return {
      content,
      analysis: analyzeCsvContent(content, {
        key: context.key,
        maskingGenerationId: context.generationId,
        intakeSessionId: context.intakeSessionId,
        headerMode: input.headerMode,
        headers: input.headers,
        additionalSensitiveColumns: input.additionalSensitiveColumns,
        confirmed: input.confirmed,
      }),
    };
  }

  createProject(input: { title: string; requirements: string; sources: SourceArtifactInput[] }): ProjectRecord {
    const requirements = input.requirements.trim();
    if (!requirements) throw new Error('requirements-missing');
    const prepared = this.#prepareCsvSources(input.sources);
    return this.repository.createProject({
      title: input.title,
      requirements,
      sources: prepared.sources,
      intakeSessionId: prepared.intakeSessionId,
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
    const prepared = this.#prepareCsvSources(input.sources, projectId);
    return this.repository.updateProject(projectId, {
      title: input.title, requirements, sources: prepared.sources, providerSettings,
    });
  }

  deleteProject(projectId: string): boolean { return this.repository.deleteProject(projectId); }

  async createAndGenerate(input: { title: string; requirements: string; sources: SourceArtifactInput[] }, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<ProjectRecord> {
    const project = this.createProject(input);
    const sources = this.#providerSources(project);
    const provider = await this.#provider(project.providerSettings!);
    const result = parseGenerationResult(await provider.generate({ requirements: project.requirements, sources, currentModel: null, clarification: null }, onProgress, signal));
    onProgress?.({ phase: 'saving', message: 'Saving the validated working draft…' });
    this.repository.saveWorkingDraft(project.id, result);
    return this.repository.getProject(project.id)!;
  }

  async regenerate(projectId: string, clarification: string | null = null, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<ProjectRecord> {
    const project = this.#project(projectId);
    const sources = this.#providerSources(project);
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
    const sources = this.#providerSources(project);
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
        sources: this.#providerSources(project),
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

  #prepareCsvSources(sources: SourceArtifactInput[], projectId?: string) {
    const normalized = normalizeSourceArtifacts(sources);
    const csvSources = normalized.filter(source => source.kind === 'csv');
    if (!csvSources.length) return { sources: normalized, intakeSessionId: null };
    const claims = new Map(csvSources.map(source => [source, this.#csvClaim(source)]));
    const intakeIds = new Set([...claims.values()].map(claim => claim.intakeSessionId).filter(Boolean));
    if (!projectId && intakeIds.size !== 1) throw new Error('csv-intake-session-expired');
    const intakeSessionId = projectId ? null : [...intakeIds][0];
    if (!projectId && !intakeSessionId) throw new Error('csv-intake-session-expired');
    const context = this.repository.getCsvMaskingContext({ projectId, intakeSessionId });
    const prepared = normalized.map(source => {
      if (source.kind !== 'csv') return source;
      const claim = claims.get(source);
      if (!claim) throw new Error('csv-analysis-required');
      if (claim.maskingGenerationId !== context.generationId) throw new Error('csv-confirmation-stale');
      const analysis = analyzeCsvContent(source.content, {
        key: context.key,
        maskingGenerationId: context.generationId,
        intakeSessionId: context.intakeSessionId,
        headerMode: claim.headerMode,
        headers: claim.headers,
        additionalSensitiveColumns: claim.additionalSensitiveColumns,
        confirmed: claim.confirmed,
      });
      if (analysis.contentDigest !== claim.contentDigest || analysis.analysisVersion !== claim.analysisVersion) {
        throw new Error('csv-confirmation-stale');
      }
      return { ...source, csvAnalysis: analysis };
    });
    return { sources: prepared, intakeSessionId: context.intakeSessionId };
  }

  #providerSources(project: ProjectRecord): ProviderSourceInput[] {
    const csvAnalyses = project.sources.flatMap(source => source.kind === 'csv' && source.csvAnalysis
      ? [source.csvAnalysis] : []);
    this.repository.validateProjectCsvMaskingGeneration(
      project.id,
      csvAnalyses.map(analysis => analysis.maskingGenerationId),
    );
    return project.sources.map(source => {
      if (source.kind !== 'csv') return { name: source.name, kind: source.kind, content: source.content };
      if (!source.csvAnalysis?.confirmed) throw new Error('csv-confirmation-required');
      return { name: source.name, kind: source.kind, content: csvProviderContext(source.name, source.csvAnalysis) };
    });
  }

  #csvClaim(source: SourceArtifactInput): CsvAnalysis {
    const claim = source.csvAnalysis as unknown;
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('csv-analysis-required');
    const value = claim as Record<string, unknown>;
    if (!Number.isSafeInteger(value.analysisVersion)
      || typeof value.contentDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.contentDigest)
      || typeof value.maskingGenerationId !== 'string' || !value.maskingGenerationId
      || value.intakeSessionId !== null && typeof value.intakeSessionId !== 'string'
      || value.headerMode !== 'first-row' && value.headerMode !== 'generated'
      || !Array.isArray(value.headers) || value.headers.some(header => typeof header !== 'string')
      || !Array.isArray(value.additionalSensitiveColumns)
      || value.additionalSensitiveColumns.some(index => !Number.isSafeInteger(index))
      || typeof value.confirmed !== 'boolean') {
      throw new Error('csv-analysis-required');
    }
    return claim as CsvAnalysis;
  }

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
