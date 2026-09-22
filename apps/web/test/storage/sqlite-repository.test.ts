import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import { claimPaymentModel, claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe('SQLite project and version lifecycle', () => {
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
});
