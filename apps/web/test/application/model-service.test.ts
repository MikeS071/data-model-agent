import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelService } from '@/application/model-service';
import { DEFAULT_PROVIDER_BASE_URL } from '@/domain/provider-settings';
import type { GenerationRequest, ModelProvider, RevisionRequest } from '@/provider/model-provider';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import { claimPaymentModel, claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

function harness(result: unknown = generatedClaimPayment) {
  const directory = mkdtempSync(join(tmpdir(), 'data-model-service-')); directories.push(directory);
  const path = join(directory, 'models.db');
  const repository = new SqliteModelRepository(path);
  const requests: GenerationRequest[] = [];
  const revisions: RevisionRequest[] = [];
  const provider: ModelProvider = {
    async generate(request) { requests.push(request); return structuredClone(result); },
    async revise(request) {
      revisions.push(request);
      const revised = structuredClone(generatedClaimPayment);
      revised.model.businessDefinition = 'Includes recovery transactions requested in chat.';
      return { ...revised, assistantMessage: 'I added recovery transactions and updated the model definition.' };
    },
  };
  return { path, repository, requests, revisions, service: new ModelService(repository, provider, { baseUrl: DEFAULT_PROVIDER_BASE_URL, model: 'test-model' }, true) };
}

describe('model application service', () => {
  it('creates a project, preserves sources and stores a validated draft', async () => {
    const { repository, requests, service } = harness();
    const project = await service.createAndGenerate({ title: 'Claim Payment', requirements: 'Model claim payments.', sources: claimSources });
    expect(project.draft).toEqual(generatedClaimPayment);
    expect(project.sources.map(({ id: _id, ordinal: _ordinal, ...source }) => source)).toEqual(claimSources);
    expect(requests).toEqual([{ requirements: 'Model claim payments.', sources: claimSources, currentModel: null, clarification: null }]);
    repository.close();
  });

  it('retains the prior draft when a regenerated provider result is invalid', async () => {
    const { repository, service } = harness();
    const project = await service.createAndGenerate({ title: 'Claim Payment', requirements: 'Model claim payments.', sources: claimSources });
    const invalidProvider: ModelProvider = {
      async generate() { return { model: { id: 'invalid' } }; },
      async revise() { return { model: { id: 'invalid' } }; },
    };
    const invalidService = new ModelService(repository, invalidProvider, { baseUrl: DEFAULT_PROVIDER_BASE_URL, model: 'test-model' }, true);
    await expect(invalidService.regenerate(project.id, 'One claim has zero or many payments.')).rejects.toThrow('entities-invalid');
    expect(repository.getProject(project.id)?.draft).toEqual(generatedClaimPayment);
    repository.close();
  });

  it('autosaves edits, versions them, and can continue from history', async () => {
    const { repository, service } = harness();
    const project = await service.createAndGenerate({ title: 'Claim Payment', requirements: 'Model claim payments.', sources: claimSources });
    const edited = structuredClone(generatedClaimPayment);
    edited.model.businessDefinition = 'Reviewed Claim-Payment definition.';
    expect(service.saveDraft(project.id, edited).model.businessDefinition).toBe('Reviewed Claim-Payment definition.');
    const version = service.saveVersion(project.id);
    expect([version.versionNumber, version.model.businessDefinition]).toEqual([1, 'Reviewed Claim-Payment definition.']);
    service.saveDraft(project.id, { ...edited, model: claimPaymentModel });
    expect(service.continueFromVersion(project.id, 1).model.businessDefinition).toBe('Reviewed Claim-Payment definition.');
    repository.close();
  });

  it('uses project chat to atomically persist the assistant reply and revised draft', async () => {
    const draftWithQuestion = {
      ...structuredClone(generatedClaimPayment),
      clarificationQuestions: ['Should an external payment reference be unique?'],
    };
    const { repository, revisions, service } = harness(draftWithQuestion);
    const project = await service.createAndGenerate({ title: 'Claim Payment', requirements: 'Model claim payments.', sources: claimSources });
    const revised = await service.reviseFromChat(project.id, 'Add recovery transactions.');

    expect(revised.draft?.model.businessDefinition).toBe('Includes recovery transactions requested in chat.');
    expect(revised.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Add recovery transactions.'],
      ['assistant', 'I added recovery transactions and updated the model definition.'],
    ]);
    expect(revisions).toEqual([expect.objectContaining({
      requirements: 'Model claim payments.', currentModel: generatedClaimPayment.model,
      clarification: 'Should an external payment reference be unique?',
      message: 'Add recovery transactions.', history: [],
    })]);
    repository.close();
  });

  it('keeps raw CSV local while preserving preview pseudonyms in provider context', async () => {
    const { path, repository, requests, service } = harness();
    const bytes = new TextEncoder().encode(
      'customer_id,email,amount\n123,a@example.com,10\n123,a@example.com,20\n',
    );
    const draft = service.analyzeCsv({ bytes });
    const confirmed = service.analyzeCsv({
      bytes,
      intakeSessionId: draft.analysis.intakeSessionId,
      headerMode: draft.analysis.headerMode,
      headers: draft.analysis.headers,
      additionalSensitiveColumns: [0, 1],
      confirmed: true,
    });
    const project = await service.createAndGenerate({
      title: 'Customer extract',
      requirements: 'Infer a customer model.',
      sources: [{ name: 'customers.csv', kind: 'csv', content: confirmed.content, csvAnalysis: confirmed.analysis }],
    });

    expect(project.sources[0].content).toContain('a@example.com');
    expect(project.sources[0].csvAnalysis?.sampleRows).toEqual(confirmed.analysis.sampleRows);
    expect(project.sources[0].csvAnalysis?.intakeSessionId).toBeNull();
    expect(requests[0].sources[0].content).not.toContain('a@example.com');
    expect(requests[0].sources[0].content).toContain('<masked:');
    expect(JSON.stringify(requests[0])).not.toContain('123,a@example.com,10');
    const prepared = service.prepareGeneration(project.id);
    expect(prepared.request.sources[0].content).toContain(confirmed.analysis.contentDigest);
    expect(prepared.request.sources[0].content).toContain(confirmed.analysis.maskingGenerationId);
    const job = repository.createGenerationJob(project.id, prepared.providerSettings, prepared.request);
    expect(JSON.stringify(job.request)).not.toContain('a@example.com');
    repository.cancelGenerationJob(job.id);
    const external = new DatabaseSync(path);
    external.prepare('DELETE FROM project_csv_masking_keys WHERE project_id=?').run(project.id);
    external.close();
    expect(() => service.prepareGeneration(project.id)).toThrow('csv-masking-key-invalid');
    expect(repository.getProject(project.id)?.sources[0].csvAnalysis?.confirmed).toBe(false);
    repository.rotateProjectCsvMaskingKey(project.id);
    expect(repository.getProject(project.id)?.sources[0].csvAnalysis?.confirmed).toBe(false);
    expect(() => service.prepareGeneration(project.id)).toThrow('csv-confirmation-required');
    expect(() => service.analyzeCsv({ bytes, intakeSessionId: draft.analysis.intakeSessionId })).toThrow('csv-intake-session-expired');
    repository.close();
  });

  it('lazily creates a first CSV key for an existing project and blocks unconfirmed context', () => {
    const { repository, service } = harness();
    const project = service.createProject({ title: 'Claims', requirements: 'Model claims.', sources: [] });
    const bytes = new TextEncoder().encode('claim_id,status\n1,OPEN\n');
    const draft = service.analyzeCsv({ bytes, projectId: project.id });

    const updated = service.updateProject(project.id, {
      title: project.title,
      requirements: project.requirements,
      sources: [{ name: 'claims.csv', kind: 'csv', content: draft.content, csvAnalysis: draft.analysis }],
    });
    expect(updated.sources[0].csvAnalysis?.confirmed).toBe(false);
    expect(() => service.prepareGeneration(project.id)).toThrow('csv-confirmation-required');
    repository.close();
  });

  it('rejects unsafe decoded CSV controls when project JSON is persisted', () => {
    const { repository, service } = harness();
    const unsafeContent = 'customer_id,name\n1,Alice\u0001Admin\n';
    const intake = service.analyzeCsv({ bytes: new TextEncoder().encode('customer_id,name\n1,Alice\n') });
    const analysis = {
      ...intake.analysis,
      contentDigest: createHash('sha256').update(unsafeContent).digest('hex'),
      confirmed: true,
      confirmedAt: '2026-10-06T00:00:00.000Z',
    };
    expect(() => service.createProject({
      title: 'Unsafe CSV',
      requirements: 'Reject unsafe controls.',
      sources: [{ name: 'unsafe.csv', kind: 'csv', content: unsafeContent, csvAnalysis: analysis }],
    })).toThrow('source-binary');
    expect(repository.listProjects()).toEqual([]);
    repository.close();
  });
});
