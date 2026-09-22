import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, downloadVersion, generateDraft, listProjects, saveVersion } from '@/server/http';
import { ModelService } from '@/application/model-service';
import type { ModelProvider } from '@/provider/model-provider';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import { claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'data-model-http-')); directories.push(directory);
  const repository = new SqliteModelRepository(join(directory, 'models.db'));
  const provider: ModelProvider = { async generate() { return structuredClone(generatedClaimPayment); } };
  return { repository, service: new ModelService(repository, provider) };
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
});
