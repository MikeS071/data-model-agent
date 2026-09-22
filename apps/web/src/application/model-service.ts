import { normalizeSourceArtifacts } from '@/domain/input';
import { parseGenerationResult } from '@/domain/model';
import type { GenerationResult, SourceArtifactInput } from '@/domain/model';
import type { ModelProvider } from '@/provider/model-provider';
import type { ModelVersion, ProjectRecord } from '@/storage/sqlite-repository';
import { SqliteModelRepository } from '@/storage/sqlite-repository';

export class ModelService {
  constructor(readonly repository: SqliteModelRepository, readonly provider: ModelProvider) {}

  createProject(input: { title: string; requirements: string; sources: SourceArtifactInput[] }): ProjectRecord {
    const requirements = input.requirements.trim();
    if (!requirements) throw new Error('requirements-missing');
    return this.repository.createProject({ title: input.title, requirements, sources: normalizeSourceArtifacts(input.sources) });
  }

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
