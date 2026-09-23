import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWithModel, createProject, deleteProject, downloadVersion, generateDraft, getProviderSettings, listProjects, saveProviderSettings, saveVersion, updateProject } from '@/server/http';
import { ModelService } from '@/application/model-service';
import type { ModelProvider } from '@/provider/model-provider';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import { claimSources, generatedClaimPayment } from '../fixtures/claim-payment';
import { DEFAULT_PROVIDER_BASE_URL } from '@/domain/provider-settings';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'data-model-http-')); directories.push(directory);
  const repository = new SqliteModelRepository(join(directory, 'models.db'));
  const provider: ModelProvider = {
    async generate() { return structuredClone(generatedClaimPayment); },
    async revise() { return { ...structuredClone(generatedClaimPayment), assistantMessage: 'The model now includes recovery transactions.' }; },
  };
  return { repository, service: new ModelService(repository, provider, { baseUrl: DEFAULT_PROVIDER_BASE_URL, model: 'test-model' }, true) };
}

describe('project HTTP boundary', () => {
  it('creates, lists, generates, versions and downloads through observable responses', async () => {
    const { repository, service } = harness();
    const createdResponse = await createProject(new Request('http://local/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Claim Payment', requirements: 'Model claim payments.', sources: claimSources }),
    }), service);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect([created.title, created.draft, created.sources.map((source: { name: string }) => source.name)]).toEqual([
      'Claim Payment', null, ['claim-payment.md', 'existing.ddl'],
    ]);

    expect(await (await listProjects(service)).json()).toEqual([
      { id: created.id, title: 'Claim Payment', updatedAt: expect.any(String), versionCount: 0, hasDraft: false },
    ]);
    const generated = await (await generateDraft(created.id, new Request('http://local', { method: 'POST', body: '{}' }), service)).json();
    expect(generated.draft.model.name).toBe('Claim Payment');
    const version = await (await saveVersion(created.id, service)).json();
    expect(version.versionNumber).toBe(1);

    const download = downloadVersion(created.id, 1, 'mermaid', service);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="claim-payment-v1.mmd"');
    expect(await download.text()).toContain('CLAIM ||--o{ PAYMENT : has');
    repository.close();
  });

  it('returns a safe validation error without reflecting private request content', async () => {
    const { repository, service } = harness();
    const response = await createProject(new Request('http://local/api/projects', {
      method: 'POST', body: JSON.stringify({ title: '', requirements: 'PRIVATE-MARKER', sources: [] }),
    }), service);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'project-input-invalid' });
    expect(body).not.toContain('PRIVATE-MARKER');
    repository.close();
  });

  it('updates and deletes an ungenerated project through observable responses', async () => {
    const { repository, service } = harness();
    const created = await (await createProject(new Request('http://local/api/projects', {
      method: 'POST', body: JSON.stringify({ title: 'First name', requirements: 'First requirements.', sources: [] }),
    }), service)).json();
    const updatedResponse = await updateProject(created.id, new Request('http://local/api/projects/project-1', {
      method: 'PUT', body: JSON.stringify({ title: 'Claims Payment', requirements: 'Revised requirements.', sources: claimSources }),
    }), service);
    expect(updatedResponse.status).toBe(200);
    expect(await updatedResponse.json()).toEqual(expect.objectContaining({
      id: created.id, title: 'Claims Payment', requirements: 'Revised requirements.',
    }));

    expect(deleteProject(created.id, service).status).toBe(204);
    expect(service.getProject(created.id)).toBeNull();
    expect(deleteProject(created.id, service).status).toBe(404);
    repository.close();
  });

  it('updates a generated model through project chat', async () => {
    const { repository, service } = harness();
    const project = await service.createAndGenerate({ title: 'Claim Payment', requirements: 'Model claim payments.', sources: claimSources });
    const response = await chatWithModel(project.id, new Request('http://local/api/projects/project-1/chat', {
      method: 'POST', body: JSON.stringify({ message: 'Add recovery transactions.' }),
    }), service);
    expect(response.status).toBe(200);
    expect((await response.json()).messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Add recovery transactions.' }),
      expect.objectContaining({ role: 'assistant', content: 'The model now includes recovery transactions.' }),
    ]);
    repository.close();
  });

  it('reads and saves provider settings without returning a credential', async () => {
    const { repository, service } = harness();
    expect(await (await getProviderSettings(service)).json()).toEqual({
      baseUrl: 'https://api.openai.com/v1', model: 'test-model', apiKeyConfigured: true,
    });
    const response = await saveProviderSettings(new Request('http://local/api/settings/provider', {
      method: 'PUT', body: JSON.stringify({ baseUrl: 'https://models.example/v1/', model: 'claims-model' }),
    }), service);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      baseUrl: 'https://models.example/v1', model: 'claims-model', apiKeyConfigured: true,
    });
    const invalid = await saveProviderSettings(new Request('http://local/api/settings/provider', {
      method: 'PUT', body: JSON.stringify({ baseUrl: 'ftp://models.example/v1', model: 'replacement' }),
    }), service);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'provider-settings-invalid' });
    expect(await (await getProviderSettings(service)).json()).toEqual({
      baseUrl: 'https://models.example/v1', model: 'claims-model', apiKeyConfigured: true,
    });
    repository.close();
  });
});
