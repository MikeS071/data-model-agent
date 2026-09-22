import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import { claimPaymentModel, claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe('SQLite project and version lifecycle', () => {
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
