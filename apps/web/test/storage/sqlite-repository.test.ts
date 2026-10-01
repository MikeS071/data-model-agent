import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import { claimPaymentModel, claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe('SQLite project and version lifecycle', () => {
  it('migrates a populated schema-v7 database without changing existing source rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'data-model-v7-')); directories.push(directory);
    const path = join(directory, 'models.db');
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations(version) VALUES (7);
      CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,requirements TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE source_artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,name TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,ordinal INTEGER NOT NULL,UNIQUE(project_id,ordinal));
      CREATE TABLE working_drafts(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,model_json TEXT NOT NULL,assumptions_json TEXT NOT NULL,warnings_json TEXT NOT NULL,questions_json TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE model_versions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,version_number INTEGER NOT NULL,model_json TEXT NOT NULL,assumptions_json TEXT NOT NULL,warnings_json TEXT NOT NULL,questions_json TEXT NOT NULL,sources_json TEXT NOT NULL,mermaid TEXT NOT NULL,drawio TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(project_id,version_number));
      CREATE TABLE generation_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,status TEXT NOT NULL,provider_type TEXT NOT NULL,base_url TEXT NOT NULL,model TEXT NOT NULL,request_json TEXT NOT NULL,phase TEXT NOT NULL,message TEXT NOT NULL,transcript TEXT NOT NULL DEFAULT '',error_code TEXT,created_at TEXT NOT NULL,started_at TEXT,heartbeat_at TEXT,completed_at TEXT,updated_at TEXT NOT NULL);
      INSERT INTO projects VALUES ('project-v7','Existing','Keep this requirement.','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO source_artifacts VALUES ('source-v7','project-v7','existing.ddl','ddl','CREATE TABLE existing(id TEXT);',0);
    `);
    database.prepare('INSERT INTO working_drafts VALUES (?,?,?,?,?,?)').run(
      'project-v7',
      JSON.stringify(generatedClaimPayment.model),
      JSON.stringify(generatedClaimPayment.assumptions),
      JSON.stringify(generatedClaimPayment.warnings),
      JSON.stringify(generatedClaimPayment.clarificationQuestions),
      '2026-01-01T00:00:00.000Z',
    );
    database.prepare('INSERT INTO model_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      'version-v7',
      'project-v7',
      1,
      JSON.stringify(generatedClaimPayment.model),
      JSON.stringify(generatedClaimPayment.assumptions),
      JSON.stringify(generatedClaimPayment.warnings),
      JSON.stringify(generatedClaimPayment.clarificationQuestions),
      JSON.stringify([{ id: 'source-v7', projectId: 'project-v7', name: 'existing.ddl', kind: 'ddl', content: 'CREATE TABLE existing(id TEXT);', ordinal: 0 }]),
      'erDiagram',
      '<mxfile />',
      '2026-01-01T00:00:00.000Z',
    );
    database.prepare('INSERT INTO generation_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'job-v7',
      'project-v7',
      'failed',
      'openai',
      'https://api.openai.com/v1',
      'test-model',
      JSON.stringify({ requirements: 'Keep this requirement.', sources: [], currentModel: null, clarification: null }),
      'failed',
      'Prior failure.',
      '',
      'provider-failed',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:02.000Z',
    );
    database.close();

    const repository = new SqliteModelRepository(path);
    expect(repository.getProject('project-v7')).toEqual(expect.objectContaining({
      title: 'Existing',
      requirements: 'Keep this requirement.',
      sources: [expect.objectContaining({ name: 'existing.ddl', content: 'CREATE TABLE existing(id TEXT);' })],
      draft: generatedClaimPayment,
    }));
    expect(repository.getVersion('project-v7', 1)?.model).toEqual(generatedClaimPayment.model);
    expect(repository.getGenerationJob('job-v7')).toEqual(expect.objectContaining({
      status: 'failed', message: 'Prior failure.', retryOfJobId: null,
    }));
    const migrated = new DatabaseSync(path);
    expect((migrated.prepare('SELECT MAX(version) AS value FROM schema_migrations').get() as { value: number }).value).toBe(8);
    expect((migrated.prepare(`SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table'
      AND name IN ('csv_intake_sessions','project_csv_masking_keys','csv_source_analyses')`).get() as { value: number }).value).toBe(3);
    migrated.close();
    repository.close();
  });

  it('rejects an unknown newer schema before creating application tables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'data-model-newer-')); directories.push(directory);
    const path = join(directory, 'models.db');
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations(version) VALUES (9);');
    database.close();

    expect(() => new SqliteModelRepository(path)).toThrow('database-schema-newer');
    const inspected = new DatabaseSync(path);
    expect((inspected.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='projects'").get() as { value: number }).value).toBe(0);
    inspected.close();
  });

  it('persists non-secret provider settings without changing saved projects', () => {
    const directory = mkdtempSync(join(tmpdir(), 'data-model-agent-')); directories.push(directory);
    const repository = new SqliteModelRepository(join(directory, 'models.db'));
    const fallback = { baseUrl: 'https://api.openai.com/v1', model: 'environment-model' };
    const project = repository.createProject({ title: 'Claim Payment', requirements: 'Model claims.', sources: [] });

    expect(repository.getProviderSettings(fallback)).toEqual(fallback);
    expect(repository.saveProviderSettings({ baseUrl: 'https://models.example/v1/', model: 'insurance-model' })).toEqual({
      baseUrl: 'https://models.example/v1', model: 'insurance-model',
    });
    expect(repository.getProviderSettings(fallback)).toEqual({ baseUrl: 'https://models.example/v1', model: 'insurance-model' });
    expect(repository.getProviderSettings({ ...fallback, model: 'gpt-5.6-sol' }, 'copilot-sdk')).toEqual({
      ...fallback, model: 'gpt-5.6-sol',
    });
    repository.saveProviderSettings({ ...fallback, model: 'gpt-5.6-sol' }, 'copilot-sdk');
    expect(repository.getProviderSettings(fallback)).toEqual({ baseUrl: 'https://models.example/v1', model: 'insurance-model' });
    expect(repository.getProviderSettings(fallback, 'copilot-sdk')).toEqual({ ...fallback, model: 'gpt-5.6-sol' });
    expect(repository.getProviderSettings({ ...fallback, model: 'gpt-5.6-sol' }, 'vscode-agent-host')).toEqual({
      ...fallback, model: 'gpt-5.6-sol',
    });
    expect(repository.getProject(project.id)?.requirements).toBe('Model claims.');
    repository.close();
  });

  it('updates pre-generation intake and deletes the project with its dependent records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'data-model-agent-')); directories.push(directory);
    const repository = new SqliteModelRepository(join(directory, 'models.db'));
    const project = repository.createProject({ title: 'First name', requirements: 'First requirements.', sources: [] });

    const updated = repository.updateProject(project.id, {
      title: 'Claims Payment', requirements: 'Revised requirements.', sources: claimSources,
    });
    expect([updated.title, updated.requirements, updated.sources.map(source => source.name)]).toEqual([
      'Claims Payment', 'Revised requirements.', ['claim-payment.md', 'existing.ddl'],
    ]);

    repository.saveWorkingDraft(project.id, generatedClaimPayment);
    const revised = structuredClone(generatedClaimPayment);
    revised.model.businessDefinition = 'Revised through chat.';
    repository.saveChatTurn(project.id, 'Revise the definition.', 'I revised the definition.', revised);
    expect(repository.getProject(project.id)?.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Revise the definition.'], ['assistant', 'I revised the definition.'],
    ]);
    expect(repository.getProject(project.id)?.draft?.model.businessDefinition).toBe('Revised through chat.');
    repository.saveVersion(project.id);
    expect(repository.deleteProject(project.id)).toBe(true);
    expect(repository.getProject(project.id)).toBeNull();
    expect(repository.getVersion(project.id, 1)).toBeNull();
    expect(repository.listProjects()).toEqual([]);
    expect(repository.deleteProject(project.id)).toBe(false);
    repository.close();
  });

  it('preserves sources, autosaves one draft and creates immutable versions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'data-model-agent-')); directories.push(directory);
    const repository = new SqliteModelRepository(join(directory, 'models.db'));
    const project = repository.createProject({ title: 'Claim Payment', requirements: 'Model claim payments.', sources: claimSources });
    repository.saveWorkingDraft(project.id, generatedClaimPayment);
    const changed = structuredClone(generatedClaimPayment);
    changed.model.businessDefinition = 'Edited working definition.';
    repository.saveWorkingDraft(project.id, changed);

    const first = repository.saveVersion(project.id);
    changed.model.businessDefinition = 'Second version definition.';
    repository.saveWorkingDraft(project.id, changed);
    const second = repository.saveVersion(project.id);

    expect([first.versionNumber, second.versionNumber]).toEqual([1, 2]);
    expect(repository.getVersion(project.id, 1)?.model).toEqual({ ...claimPaymentModel, businessDefinition: 'Edited working definition.' });
    expect(repository.getVersion(project.id, 2)?.model.businessDefinition).toBe('Second version definition.');
    expect(repository.getProject(project.id)?.sources).toEqual(claimSources.map((source, index) => ({ ...source, id: expect.any(String), ordinal: index })));
    expect(repository.listProjects()).toEqual([{ id: project.id, title: 'Claim Payment', updatedAt: expect.any(String), versionCount: 2, hasDraft: true }]);

    repository.continueFromVersion(project.id, 1);
    expect(repository.getProject(project.id)?.draft?.model.businessDefinition).toBe('Edited working definition.');
    repository.close();
  });

  it('persists project provider settings and durable generation progress independently', () => {
    const directory = mkdtempSync(join(tmpdir(), 'data-model-service-')); directories.push(directory);
    const repository = new SqliteModelRepository(join(directory, 'models.db'));
    const providerSettings = {
      providerType: 'vscode-agent-host' as const,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-sol',
    };
    const project = repository.createProject({
      title: 'Claim Payment', requirements: 'Model claims.', sources: claimSources, providerSettings,
    });
    expect(project.providerSettings).toEqual(providerSettings);

    const job = repository.createGenerationJob(project.id, providerSettings, {
      requirements: project.requirements,
      sources: claimSources,
      currentModel: null,
      clarification: null,
    });
    expect(job.status).toBe('queued');
    repository.claimGenerationJob(job.id);
    repository.updateGenerationJobProgress(job.id, 'receiving', 'Receiving live model output…', '{"model":');
    expect(repository.getGenerationJob(job.id)).toEqual(expect.objectContaining({
      status: 'running', phase: 'receiving', transcript: '{"model":',
    }));
    repository.completeGenerationJob(job.id, generatedClaimPayment);
    expect(repository.getGenerationJob(job.id)?.status).toBe('completed');
    expect(repository.getProject(project.id)?.draft).toEqual(generatedClaimPayment);

    const cancelled = repository.createGenerationJob(project.id, providerSettings, {
      requirements: project.requirements,
      sources: claimSources,
      currentModel: generatedClaimPayment.model,
      clarification: null,
    });
    repository.claimGenerationJob(cancelled.id);
    repository.cancelGenerationJob(cancelled.id);
    const replacement = structuredClone(generatedClaimPayment);
    replacement.model.businessDefinition = 'A cancelled result must never be saved.';
    expect(() => repository.completeGenerationJob(cancelled.id, replacement)).toThrow('generation-job-unavailable');
    expect(repository.getGenerationJob(cancelled.id)?.status).toBe('cancelled');
    expect(repository.getProject(project.id)?.draft).toEqual(generatedClaimPayment);
    repository.close();
  });

  it('keeps healthy jobs active across connections and interrupts them after the heartbeat becomes stale', () => {
    const directory = mkdtempSync(join(tmpdir(), 'data-model-service-')); directories.push(directory);
    const path = join(directory, 'models.db');
    const providerSettings = {
      providerType: 'vscode-agent-host' as const,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-sol',
    };
    const first = new SqliteModelRepository(path);
    const project = first.createProject({ title: 'Claim Payment', requirements: 'Model claims.', sources: [], providerSettings });
    const job = first.createGenerationJob(project.id, providerSettings, {
      requirements: project.requirements, sources: [], currentModel: null, clarification: null,
    });
    first.claimGenerationJob(job.id);

    const concurrent = new SqliteModelRepository(path);
    expect(concurrent.getGenerationJob(job.id)?.status).toBe('running');
    expect(() => concurrent.createGenerationJob(project.id, providerSettings, {
      requirements: project.requirements, sources: [], currentModel: null, clarification: null,
    })).toThrow('generation-in-progress');
    concurrent.close();
    first.close();

    const reopened = new SqliteModelRepository(path, { now: () => Date.now() + 61_000 });
    expect(reopened.getGenerationJob(job.id)).toEqual(expect.objectContaining({
      status: 'interrupted',
      error: 'generation-interrupted',
    }));
    reopened.close();
  });
});
