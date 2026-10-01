import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import { claimPaymentModel, claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe('SQLite project and version lifecycle', () => {
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
