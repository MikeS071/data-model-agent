import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CopilotClient,
  type GetAuthStatusResponse,
  type MessageOptions,
  type ModelInfo,
  type ResponseSchema,
  type SessionConfig,
} from '@github/copilot-sdk';
import {
  GENERATION_INSTRUCTIONS,
  REVISION_INSTRUCTIONS,
  environmentInteger,
  generationInput,
  generationJsonSchema,
  revisionInput,
  revisionJsonSchema,
} from './openai-provider';
import type { GenerationRequest, ModelProvider, ProviderProgressHandler, RevisionRequest } from './model-provider';

interface CopilotSessionLike {
  readonly sessionId: string;
  sendAndWait<TResult>(options: MessageOptions | string, responseSchema: ResponseSchema<TResult>, timeout?: number): Promise<TResult>;
  disconnect(): Promise<void>;
  abort(): Promise<void>;
}

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  getAuthStatus(): Promise<GetAuthStatusResponse>;
  listModels(): Promise<ModelInfo[]>;
  createSession(config: SessionConfig): Promise<CopilotSessionLike>;
  deleteSession(sessionId: string): Promise<void>;
}

interface CopilotProviderOptions {
  model: string;
  timeoutMs?: number;
  reasoningEffort?: CopilotReasoningEffort;
  clientFactory?: () => CopilotClientLike;
  now?: () => number;
}

type CopilotReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const reasoningEfforts: CopilotReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const environmentEffort = (value: string | undefined): CopilotReasoningEffort => {
  const effort = value ?? 'high';
  if (!reasoningEfforts.includes(effort as CopilotReasoningEffort)) throw new Error('provider-config-invalid');
  return effort as CopilotReasoningEffort;
};

const responseSchema = (schema: object): ResponseSchema<unknown> => ({
  _output: undefined,
  toJSONSchema: () => ({ ...schema }),
  parse: value => value,
});

const providerError = (error: unknown) => {
  if (error instanceof Error && error.message.startsWith('provider-')) return error;
  if (error instanceof Error && /(quota|rate.?limit|too many requests)/iu.test(error.message)) {
    return new Error('provider-rate-limited', { cause: error });
  }
  if (error instanceof SyntaxError) return new Error('provider-output-invalid', { cause: error });
  if (error instanceof Error && /timed?\s*out|timeout/iu.test(error.message)) {
    return new Error('provider-timeout', { cause: error });
  }
  return new Error('provider-unavailable', { cause: error });
};

const defaultClient = (): CopilotClientLike => new CopilotClient({
  mode: 'empty',
  baseDirectory: process.env.COPILOT_HOME?.trim() || join(homedir(), '.copilot'),
  workingDirectory: process.cwd(),
  logLevel: 'warning',
  useLoggedInUser: true,
  clientInfo: {
    applicationName: 'data-model-agent',
    applicationVersion: '0.1.0',
  },
});

export class CopilotModelProvider implements ModelProvider {
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #reasoningEffort: CopilotReasoningEffort;
  readonly #clientFactory: () => CopilotClientLike;
  readonly #now: () => number;

  constructor(options: CopilotProviderOptions) {
    if (!options.model?.trim()) throw new Error('provider-not-configured');
    this.#model = options.model.trim();
    this.#timeoutMs = environmentInteger(String(options.timeoutMs ?? 120_000), 120_000, 1_000, 600_000);
    this.#reasoningEffort = options.reasoningEffort ?? 'high';
    this.#clientFactory = options.clientFactory ?? defaultClient;
    this.#now = options.now ?? Date.now;
  }

  static fromEnvironment(
    environment: Record<string, string | undefined> = process.env,
    runtime: Pick<CopilotProviderOptions, 'clientFactory' | 'now'> = {},
  ) {
    return new CopilotModelProvider({
      model: environment.COPILOT_MODEL ?? '',
      timeoutMs: environmentInteger(environment.COPILOT_TIMEOUT_MS, 120_000, 1_000, 600_000),
      reasoningEffort: environmentEffort(environment.COPILOT_REASONING_EFFORT),
      ...runtime,
    });
  }

  async #cleanup(client: CopilotClientLike, session: CopilotSessionLike | undefined) {
    if (session) {
      try { await session.disconnect(); }
      catch (error) { console.warn('copilot-provider cleanup failed', { phase: 'disconnect', error: error instanceof Error ? error.name : 'unknown' }); }
      try { await client.deleteSession(session.sessionId); }
      catch (error) { console.warn('copilot-provider cleanup failed', { phase: 'delete-session', error: error instanceof Error ? error.name : 'unknown' }); }
    }
    try {
      const errors = await client.stop();
      if (errors.length) console.warn('copilot-provider cleanup failed', { phase: 'stop', errors: errors.map(error => error.name) });
    } catch (error) {
      console.warn('copilot-provider cleanup failed', { phase: 'stop', error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  async #complete(input: string, schema: object, instructions: string, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<unknown> {
    const startedAt = this.#now();
    let client: CopilotClientLike | undefined;
    let session: CopilotSessionLike | undefined;
    const abort = () => { if (session) void session.abort(); };
    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error('provider-unavailable');
    };
    try {
      throwIfAborted();
      signal?.addEventListener('abort', abort, { once: true });
      onProgress?.({ phase: 'connecting', message: 'Starting the GitHub Copilot runtime…' });
      client = this.#clientFactory();
      await client.start();
      throwIfAborted();
      const authentication = await client.getAuthStatus();
      throwIfAborted();
      if (!authentication.isAuthenticated) throw new Error('provider-not-configured');

      const models = await client.listModels();
      throwIfAborted();
      onProgress?.({ phase: 'selecting-model', message: `Selecting ${this.#model}…` });
      const model = models.find(candidate => candidate.id === this.#model);
      if (!model || model.policy && model.policy.state !== 'enabled'
        || model.capabilities.supports.reasoningEffort && model.supportedReasoningEfforts
          && !model.supportedReasoningEfforts.includes(this.#reasoningEffort)) {
        throw new Error('provider-config-invalid');
      }

      session = await client.createSession({
        clientName: 'data-model-agent',
        model: this.#model,
        ...(model.capabilities.supports.reasoningEffort ? { reasoningEffort: this.#reasoningEffort } : {}),
        reasoningSummary: 'none',
        systemMessage: { mode: 'append', content: instructions },
        availableTools: [],
        tools: [],
        onPermissionRequest: () => ({ kind: 'reject', feedback: 'Tool use is disabled for data-model generation.' }),
        enableConfigDiscovery: false,
        skipCustomInstructions: true,
        enableHostGitOperations: false,
        enableSessionStore: false,
        enableSkills: false,
        memory: { enabled: false },
        infiniteSessions: { enabled: false },
        remoteSession: 'off',
      });
      if (signal?.aborted) {
        await session.abort();
        throw new Error('provider-unavailable');
      }
      onProgress?.({ phase: 'generating', message: `${this.#model} is building the model…` });
      const result = await session.sendAndWait({ prompt: input }, responseSchema(schema), this.#timeoutMs);
      onProgress?.({ phase: 'validating', message: 'Validating the completed model…' });
      console.info('copilot-provider', { outcome: 'completed', model: this.#model, durationMs: this.#now() - startedAt });
      return result;
    } catch (error) {
      const mapped = providerError(error);
      const errorCode = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
      console.info('copilot-provider', {
        outcome: mapped.message, model: this.#model, durationMs: this.#now() - startedAt,
        errorName: error instanceof Error ? error.name : 'unknown', errorCode,
      });
      throw mapped;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (client) await this.#cleanup(client, session);
    }
  }

  generate(request: GenerationRequest, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<unknown> {
    return this.#complete(generationInput(request), generationJsonSchema, GENERATION_INSTRUCTIONS, onProgress, signal);
  }

  revise(request: RevisionRequest, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<unknown> {
    return this.#complete(revisionInput(request), revisionJsonSchema, REVISION_INSTRUCTIONS, onProgress, signal);
  }
}
