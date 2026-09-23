import { normalizeSourceArtifacts } from '@/domain/input';
import { parseGenerationResult, parseRevisionResult } from '@/domain/model';
import type { GenerationResult, SourceArtifactInput } from '@/domain/model';
import type { ModelProvider } from '@/provider/model-provider';
import type { ProviderSettings } from '@/domain/provider-settings';
import type { ModelVersion, ProjectRecord } from '@/storage/sqlite-repository';
import { SqliteModelRepository } from '@/storage/sqlite-repository';

export class ModelService {
  constructor(
    readonly repository: SqliteModelRepository,
    readonly provider: ModelProvider,
    readonly providerDefaults: ProviderSettings,
    readonly apiKeyConfigured: boolean,
  ) {}

  getProviderSettings() {
    return { ...this.repository.getProviderSettings(this.providerDefaults), apiKeyConfigured: this.apiKeyConfigured };
  }

  saveProviderSettings(input: ProviderSettings) {
    return { ...this.repository.saveProviderSettings(input), apiKeyConfigured: this.apiKeyConfigured };
  }

  createProject(input: { title: string; requirements: string; sources: SourceArtifactInput[] }): ProjectRecord {
    const requirements = input.requirements.trim();
    if (!requirements) throw new Error('requirements-missing');
    return this.repository.createProject({ title: input.title, requirements, sources: normalizeSourceArtifacts(input.sources) });
  }

  updateProject(projectId: string, input: { title: string; requirements: string; sources: SourceArtifactInput[] }): ProjectRecord {
    const requirements = input.requirements.trim();
    if (!requirements) throw new Error('requirements-missing');
    return this.repository.updateProject(projectId, {
      title: input.title, requirements, sources: normalizeSourceArtifacts(input.sources),
    });
  }

  deleteProject(projectId: string): boolean { return this.repository.deleteProject(projectId); }

  async createAndGenerate(input: { title: string; requirements: string; sources: SourceArtifactInput[] }): Promise<ProjectRecord> {
    const project = this.createProject(input);
    const sources = project.sources.map(({ name, kind, content }) => ({ name, kind, content }));
    const result = parseGenerationResult(await this.provider.generate({ requirements: project.requirements, sources, currentModel: null, clarification: null }));
    this.repository.saveWorkingDraft(project.id, result);
    return this.repository.getProject(project.id)!;
  }

  async regenerate(projectId: string, clarification: string | null = null): Promise<ProjectRecord> {
    const project = this.repository.getProject(projectId);
    if (!project) throw new Error('project-missing');
    const sources = project.sources.map(({ name, kind, content }) => ({ name, kind, content }));
    const result = parseGenerationResult(await this.provider.generate({
      requirements: project.requirements, sources, currentModel: project.draft?.model ?? null,
      clarification: clarification?.trim() || null,
    }));
    this.repository.saveWorkingDraft(project.id, result);
    return this.repository.getProject(project.id)!;
  }

  async reviseFromChat(projectId: string, input: string): Promise<ProjectRecord> {
    const project = this.repository.getProject(projectId), message = input.trim();
    if (!project) throw new Error('project-missing');
    if (!project.draft) throw new Error('draft-missing');
    if (!message || message.length > 4_000) throw new Error('chat-message-invalid');
    const sources = project.sources.map(({ name, kind, content }) => ({ name, kind, content }));
    const history = project.messages.slice(-12).map(({ role, content }) => ({ role, content }));
    const revision = parseRevisionResult(await this.provider.revise({
      requirements: project.requirements, sources, currentModel: project.draft.model,
      clarification: project.draft.clarificationQuestions[0] ?? null, message, history,
    }));
    return this.repository.saveChatTurn(projectId, message, revision.assistantMessage, revision);
  }

  saveDraft(projectId: string, draft: GenerationResult): GenerationResult {
    if (!this.repository.getProject(projectId)) throw new Error('project-missing');
    return this.repository.saveWorkingDraft(projectId, draft);
  }

  saveVersion(projectId: string): ModelVersion { return this.repository.saveVersion(projectId); }
  continueFromVersion(projectId: string, versionNumber: number): GenerationResult { return this.repository.continueFromVersion(projectId, versionNumber); }
  getProject(projectId: string): ProjectRecord | null { return this.repository.getProject(projectId); }
  getVersion(projectId: string, versionNumber: number): ModelVersion | null { return this.repository.getVersion(projectId, versionNumber); }
  listProjects() { return this.repository.listProjects(); }
}
