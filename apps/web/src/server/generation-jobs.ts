import { parseGenerationResult } from '@/domain/model';
import type { ProviderProgress } from '@/provider/model-provider';
import type { ModelService } from '@/application/model-service';
import type { ProviderFactory } from '@/server/providers';
import type { GenerationJobRecord } from '@/storage/sqlite-repository';
import { SqliteModelRepository } from '@/storage/sqlite-repository';

const knownErrors = new Set([
  'provider-not-configured', 'provider-timeout', 'provider-unavailable', 'provider-rate-limited',
  'provider-failed', 'provider-config-invalid', 'provider-output-missing', 'provider-output-invalid',
  'provider-output-incomplete', 'generation-result-invalid', 'entities-invalid',
]);

const errorCode = (error: unknown) => error instanceof Error && knownErrors.has(error.message)
  ? error.message : 'request-failed';

export class GenerationJobManager {
  readonly #repository: SqliteModelRepository;
  readonly #providerFactory: ProviderFactory;
  readonly #controllers = new Map<string, AbortController>();

  constructor(repository: SqliteModelRepository, providerFactory: ProviderFactory) {
    this.#repository = repository;
    this.#providerFactory = providerFactory;
  }

  start(service: ModelService, projectId: string, clarification: string | null = null): GenerationJobRecord {
    const prepared = service.prepareGeneration(projectId, clarification);
    const job = this.#repository.createGenerationJob(projectId, prepared.providerSettings, prepared.request);
    const controller = new AbortController();
    this.#controllers.set(job.id, controller);
    void this.#run(job.id, controller).catch(error => {
      console.error('generation-job runner failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : 'unknown',
      });
    });
    return job;
  }

  get(id: string): GenerationJobRecord {
    const job = this.#repository.getGenerationJob(id);
    if (!job) throw new Error('generation-job-missing');
    return job;
  }

  latest(projectId: string): GenerationJobRecord | null {
    return this.#repository.getLatestGenerationJob(projectId);
  }

  cancel(id: string): GenerationJobRecord {
    const job = this.get(id);
    if (job.status !== 'queued' && job.status !== 'running') throw new Error('generation-job-unavailable');
    this.#controllers.get(id)?.abort();
    return this.#repository.cancelGenerationJob(id);
  }

  async #run(id: string, controller: AbortController) {
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingDelta = '';
    let lastPhase = 'generating';
    let lastMessage = 'Receiving live model output…';
    let stopped = false;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!pendingDelta || stopped) return;
      const delta = pendingDelta;
      pendingDelta = '';
      try { this.#repository.updateGenerationJobProgress(id, lastPhase, lastMessage, delta); }
      catch {
        stopped = true;
      }
    };
    const progress = (event: ProviderProgress) => {
      if (stopped) return;
      lastPhase = event.phase;
      lastMessage = event.message;
      if (event.transcriptDelta) {
        pendingDelta += event.transcriptDelta;
        if (!flushTimer) flushTimer = setTimeout(() => {
          try { flush(); }
          catch (error) {
            console.warn('generation-job progress flush failed', {
              jobId: id, error: error instanceof Error ? error.message : 'unknown',
            });
          }
        }, 200);
        return;
      }
      flush();
      if (stopped) return;
      try { this.#repository.updateGenerationJobProgress(id, event.phase, event.message); }
      catch { stopped = true; }
    };
    const heartbeat = setInterval(() => {
      try {
        flush();
        this.#repository.heartbeatGenerationJob(id);
      } catch (error) {
        console.warn('generation-job heartbeat failed', {
          jobId: id, error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }, 3000);

    try {
      const job = this.#repository.claimGenerationJob(id);
      const provider = await this.#providerFactory(job.providerSettings);
      const result = parseGenerationResult(await provider.generate(job.request, progress, controller.signal));
      flush();
      progress({ phase: 'saving', message: 'Saving the validated working draft…' });
      this.#repository.completeGenerationJob(id, result);
    } catch (error) {
      const job = this.#repository.getGenerationJob(id);
      if (job && job.status !== 'cancelled') {
        try { this.#repository.failGenerationJob(id, errorCode(error), 'Generation stopped before a valid model was produced.'); }
        catch { /* The project or job may have been removed concurrently. */ }
      }
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      clearInterval(heartbeat);
      this.#controllers.delete(id);
    }
  }
}
