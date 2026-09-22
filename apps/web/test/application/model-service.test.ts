import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelService } from '@/application/model-service';
import type { GenerationRequest, ModelProvider, RevisionRequest } from '@/provider/model-provider';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import { claimPaymentModel, claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

function harness(result: unknown = generatedClaimPayment) {
  const directory = mkdtempSync(join(tmpdir(), 'data-model-service-')); directories.push(directory);
  const repository = new SqliteModelRepository(join(directory, 'models.db'));
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
  return { repository, requests, revisions, service: new ModelService(repository, provider) };
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
    const invalidService = new ModelService(repository, invalidProvider);
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
    const { repository, revisions, service } = harness();
    const project = await service.createAndGenerate({ title: 'Claim Payment', requirements: 'Model claim payments.', sources: claimSources });
    const revised = await service.reviseFromChat(project.id, 'Add recovery transactions.');

    expect(revised.draft?.model.businessDefinition).toBe('Includes recovery transactions requested in chat.');
    expect(revised.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Add recovery transactions.'],
      ['assistant', 'I added recovery transactions and updated the model definition.'],
    ]);
    expect(revisions).toEqual([expect.objectContaining({
      requirements: 'Model claim payments.', currentModel: generatedClaimPayment.model,
      message: 'Add recovery transactions.', history: [],
    })]);
    repository.close();
  });
});
