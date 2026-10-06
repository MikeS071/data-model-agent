import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelService } from '@/application/model-service';
import { DEFAULT_PROVIDER_BASE_URL } from '@/domain/provider-settings';
import type { ModelProvider } from '@/provider/model-provider';
import { GenerationJobManager } from '@/server/generation-jobs';
import { SqliteModelRepository } from '@/storage/sqlite-repository';
import { claimSources, generatedClaimPayment } from '../fixtures/claim-payment';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe('durable generation job manager', () => {
  it('snapshots inputs, persists progress and atomically saves a validated draft', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'generation-job-')); directories.push(directory);
    const repository = new SqliteModelRepository(join(directory, 'models.db'));
    const provider: ModelProvider = {
      async generate(request, onProgress) {
        expect(request.sources).toEqual(claimSources);
        onProgress?.({ phase: 'generating', message: 'Building the model…' });
        onProgress?.({ phase: 'receiving', message: 'Receiving live model output…', transcriptDelta: '{"model":' });
        return structuredClone(generatedClaimPayment);
      },
      async revise() { throw new Error('unexpected-revision'); },
    };
    const factory = vi.fn(async () => provider);
    const defaults = {
      providerType: 'vscode-agent-host' as const,
      baseUrl: DEFAULT_PROVIDER_BASE_URL,
      model: 'gpt-5.6-sol',
    };
    const service = new ModelService(
      repository, provider, defaults, false, defaults.providerType,
      { openai: defaults, 'copilot-sdk': defaults, 'vscode-agent-host': defaults }, factory,
    );
    const project = service.createProject({ title: 'Claim Payment', requirements: 'Model claims.', sources: claimSources });
    const manager = new GenerationJobManager(repository, factory);
    const created = manager.start(service, project.id);

    await vi.waitFor(() => expect(manager.get(created.id).status).toBe('completed'));
    expect(manager.get(created.id)).toEqual(expect.objectContaining({
      providerSettings: defaults,
      status: 'completed',
      transcript: expect.stringContaining('Receiving generated model output'),
    }));
    expect(manager.get(created.id).transcript).toContain('Connecting to the configured provider');
    expect(manager.get(created.id).transcript).toContain('Building the model');
    expect(manager.get(created.id).transcript).toContain('9 characters received');
    expect(manager.get(created.id).transcript).not.toContain('{"model":');
    expect(service.getProject(project.id)?.draft).toEqual(generatedClaimPayment);

    const retried = manager.start(service, project.id, null, created.id);
    await vi.waitFor(() => expect(manager.get(retried.id).status).toBe('completed'));
    expect(manager.get(retried.id).retryOfJobId).toBe(created.id);
    repository.close();
  });

  it('flushes a received-output summary before failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'generation-job-failure-')); directories.push(directory);
    const repository = new SqliteModelRepository(join(directory, 'models.db'));
    const provider: ModelProvider = {
      async generate(_request, onProgress) {
        onProgress?.({ phase: 'receiving', message: 'Receiving live model output…', transcriptDelta: '{"partial":true}' });
        throw new Error('provider failed');
      },
      async revise() { throw new Error('unexpected-revision'); },
    };
    const defaults = {
      providerType: 'vscode-agent-host' as const,
      baseUrl: DEFAULT_PROVIDER_BASE_URL,
      model: 'gpt-5.6-sol',
    };
    const service = new ModelService(
      repository, provider, defaults, false, defaults.providerType,
      { openai: defaults, 'copilot-sdk': defaults, 'vscode-agent-host': defaults }, async () => provider,
    );
    const project = service.createProject({ title: 'Failure', requirements: 'Model failure.', sources: [] });
    const manager = new GenerationJobManager(repository, async () => provider);
    const job = manager.start(service, project.id);

    await vi.waitFor(() => expect(manager.get(job.id).status).toBe('failed'));
    expect(manager.get(job.id).transcript).toContain('16 characters received');
    expect(manager.get(job.id).transcript).not.toContain('{"partial":true}');
    repository.close();
  });

  it('flushes a received-output summary before cancellation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'generation-job-cancel-')); directories.push(directory);
    const repository = new SqliteModelRepository(join(directory, 'models.db'));
    const provider: ModelProvider = {
      async generate(_request, onProgress, signal) {
        onProgress?.({ phase: 'receiving', message: 'Receiving live model output…', transcriptDelta: '{"partial":true}' });
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      },
      async revise() { throw new Error('unexpected-revision'); },
    };
    const defaults = {
      providerType: 'vscode-agent-host' as const,
      baseUrl: DEFAULT_PROVIDER_BASE_URL,
      model: 'gpt-5.6-sol',
    };
    const service = new ModelService(
      repository, provider, defaults, false, defaults.providerType,
      { openai: defaults, 'copilot-sdk': defaults, 'vscode-agent-host': defaults }, async () => provider,
    );
    const project = service.createProject({ title: 'Cancellation', requirements: 'Model cancellation.', sources: [] });
    const manager = new GenerationJobManager(repository, async () => provider);
    const job = manager.start(service, project.id);

    await vi.waitFor(() => expect(manager.get(job.id).status).toBe('running'));
    manager.cancel(job.id);
    expect(manager.get(job.id).status).toBe('cancelled');
    expect(manager.get(job.id).transcript).toContain('16 characters received');
    expect(manager.get(job.id).transcript).not.toContain('{"partial":true}');
    repository.close();
  });
});
