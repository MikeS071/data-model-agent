import type { GenerationRequest, ModelProvider, RevisionRequest } from './model-provider';
import { DEFAULT_PROVIDER_BASE_URL, normalizeProviderBaseUrl } from '@/domain/provider-settings';

const text = { type: 'string', minLength: 1 } as const;
const stringArray = { type: 'array', items: text } as const;
const reference = {
  anyOf: [
    { type: 'null' },
    { type: 'object', additionalProperties: false, properties: { entityId: text, attributeId: text }, required: ['entityId', 'attributeId'] },
  ],
} as const;
const attribute = {
  type: 'object', additionalProperties: false,
  properties: {
    id: text, name: text, dataType: text, required: { type: 'boolean' },
    key: { type: 'string', enum: ['PK', 'FK', 'NONE'] }, references: reference, businessDefinition: text,
  },
  required: ['id', 'name', 'dataType', 'required', 'key', 'references', 'businessDefinition'],
} as const;
const entity = {
  type: 'object', additionalProperties: false,
  properties: {
    id: text, name: text, businessDefinition: text,
    position: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
    attributes: { type: 'array', items: attribute, minItems: 1 },
  },
  required: ['id', 'name', 'businessDefinition', 'position', 'attributes'],
} as const;
const cardinality = { type: 'string', enum: ['one', 'zero-or-one', 'one-or-many', 'zero-or-many'] } as const;

export const generationJsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    model: {
      type: 'object', additionalProperties: false,
      properties: {
        id: text, name: text, businessDefinition: text,
        entities: { type: 'array', items: entity, minItems: 1 },
        relationships: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: { id: text, name: text, fromEntityId: text, toEntityId: text, fromCardinality: cardinality, toCardinality: cardinality },
            required: ['id', 'name', 'fromEntityId', 'toEntityId', 'fromCardinality', 'toCardinality'],
          },
        },
        rules: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: { id: text, name: text, expression: text, businessDefinition: text, entityIds: stringArray },
            required: ['id', 'name', 'expression', 'businessDefinition', 'entityIds'],
          },
        },
      },
      required: ['id', 'name', 'businessDefinition', 'entities', 'relationships', 'rules'],
    },
    assumptions: stringArray,
    warnings: stringArray,
    clarificationQuestions: stringArray,
  },
  required: ['model', 'assumptions', 'warnings', 'clarificationQuestions'],
} as const;

export const revisionJsonSchema = {
  ...generationJsonSchema,
  properties: { ...generationJsonSchema.properties, assistantMessage: text },
  required: [...generationJsonSchema.required, 'assistantMessage'],
} as const;

const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type ReasoningEffort = typeof reasoningEfforts[number];
type ProviderOutcome = 'completed' | 'timeout' | 'unavailable' | 'rate-limited' | 'failed' | 'output-incomplete' | 'output-invalid';

export interface ProviderDiagnostic {
  outcome: ProviderOutcome;
  model: string;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  timeoutMs: number;
  durationMs: number;
  status: number | null;
  requestId: string | null;
}

interface ProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  diagnostics?: (event: ProviderDiagnostic) => void;
  now?: () => number;
}

const configuredInteger = (value: number, minimum: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('provider-config-invalid');
  return value;
};

const environmentInteger = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new Error('provider-config-invalid');
  return configuredInteger(Number(value), minimum, maximum);
};

const environmentEffort = (value: string | undefined): ReasoningEffort => {
  const effort = value ?? 'low';
  if (!reasoningEfforts.includes(effort as ReasoningEffort)) throw new Error('provider-config-invalid');
  return effort as ReasoningEffort;
};

function outputText(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('provider-output-missing');
  const response = value as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
  for (const item of response.output ?? []) for (const content of item.content ?? []) {
    if (item.type === 'message' && content.type === 'output_text' && typeof content.text === 'string') return content.text;
  }
  throw new Error('provider-output-missing');
}

const sourceText = (request: GenerationRequest) => request.sources
  .map(source => `--- ${source.name} (${source.kind}) ---\n${source.content}`).join('\n\n');

export class OpenAIModelProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #fetcher: typeof fetch;
  readonly #timeoutMs: number;
  readonly #reasoningEffort: ReasoningEffort;
  readonly #maxOutputTokens: number;
  readonly #diagnostics: (event: ProviderDiagnostic) => void;
  readonly #now: () => number;

  constructor(options: ProviderOptions) {
    if (!options.apiKey || !options.model?.trim()) throw new Error('provider-not-configured');
    this.#apiKey = options.apiKey;
    try { this.#baseUrl = normalizeProviderBaseUrl(options.baseUrl ?? DEFAULT_PROVIDER_BASE_URL); }
    catch { throw new Error('provider-config-invalid'); }
    this.#model = options.model.trim();
    this.#fetcher = options.fetcher ?? fetch;
    this.#timeoutMs = configuredInteger(options.timeoutMs ?? 120_000, 1_000, 600_000);
    this.#reasoningEffort = options.reasoningEffort ?? 'low';
    this.#maxOutputTokens = configuredInteger(options.maxOutputTokens ?? 8_000, 256, 128_000);
    this.#diagnostics = options.diagnostics ?? (event => console.info('openai-provider', event));
    this.#now = options.now ?? Date.now;
  }

  static fromEnvironment(
    environment: Record<string, string | undefined> = process.env,
    runtime: Pick<ProviderOptions, 'fetcher' | 'diagnostics' | 'now'> = {},
  ) {
    const apiKey = environment.OPENAI_API_KEY, model = environment.OPENAI_MODEL;
    if (!apiKey || !model) throw new Error('provider-not-configured');
    return new OpenAIModelProvider({
      apiKey,
      baseUrl: environment.OPENAI_BASE_URL ?? DEFAULT_PROVIDER_BASE_URL,
      model,
      timeoutMs: environmentInteger(environment.OPENAI_TIMEOUT_MS, 120_000, 1_000, 600_000),
      reasoningEffort: environmentEffort(environment.OPENAI_REASONING_EFFORT),
      maxOutputTokens: environmentInteger(environment.OPENAI_MAX_OUTPUT_TOKENS, 8_000, 256, 128_000),
      ...runtime,
    });
  }

  #record(outcome: ProviderOutcome, startedAt: number, response: Response | null) {
    const event: ProviderDiagnostic = {
      outcome,
      model: this.#model,
      reasoningEffort: this.#reasoningEffort,
      maxOutputTokens: this.#maxOutputTokens,
      timeoutMs: this.#timeoutMs,
      durationMs: Math.max(0, this.#now() - startedAt),
      status: response?.status ?? null,
      requestId: response?.headers.get('x-request-id') ?? null,
    };
    try { this.#diagnostics(event); } catch { /* Diagnostics must never change provider behavior. */ }
  }

  async #complete(input: string, formatName: string, schema: object, instructions: string): Promise<unknown> {
    const startedAt = this.#now();
    let response: Response;
    try {
      response = await this.#fetcher(`${this.#baseUrl}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.#timeoutMs),
        body: JSON.stringify({
          model: this.#model,
          store: false,
          reasoning: { effort: this.#reasoningEffort },
          max_output_tokens: this.#maxOutputTokens,
          instructions,
          input,
          text: { format: { type: 'json_schema', name: formatName, strict: true, schema } },
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        this.#record('timeout', startedAt, null);
        throw new Error('provider-timeout');
      }
      this.#record('unavailable', startedAt, null);
      throw new Error('provider-unavailable');
    }
    if (response.status === 429) {
      this.#record('rate-limited', startedAt, response);
      throw new Error('provider-rate-limited');
    }
    if (!response.ok) {
      this.#record('failed', startedAt, response);
      throw new Error('provider-failed');
    }
    let body: unknown;
    try { body = await response.json(); } catch {
      this.#record('output-invalid', startedAt, response);
      throw new Error('provider-output-invalid');
    }
    if (body && typeof body === 'object' && (body as { status?: string }).status === 'incomplete') {
      this.#record('output-incomplete', startedAt, response);
      throw new Error('provider-output-incomplete');
    }
    try {
      const result = JSON.parse(outputText(body));
      this.#record('completed', startedAt, response);
      return result;
    } catch (error) {
      this.#record('output-invalid', startedAt, response);
      if (error instanceof Error && error.message === 'provider-output-missing') throw error;
      throw new Error('provider-output-invalid');
    }
  }

  async generate(request: GenerationRequest): Promise<unknown> {
    const sources = sourceText(request);
    const input = [
      `Requirements:\n${request.requirements}`,
      sources ? `Source artifacts:\n${sources}` : '',
      request.currentModel ? `Current canonical model:\n${JSON.stringify(request.currentModel)}` : '',
      request.clarification ? `Latest clarification:\n${request.clarification}` : '',
    ].filter(Boolean).join('\n\n');
    return this.#complete(
      input,
      'data_model_generation',
      generationJsonSchema,
      'Create a conservative data-model draft. Preserve supplied facts, label assumptions, emit warnings, and ask clarification questions instead of inventing ambiguous relationships.',
    );
  }

  async revise(request: RevisionRequest): Promise<unknown> {
    const sources = sourceText(request);
    const input = [
      `Requirements:\n${request.requirements}`,
      sources ? `Source artifacts:\n${sources}` : '',
      `Current canonical model:\n${JSON.stringify(request.currentModel)}`,
      request.clarification ? `Open clarification:\n${request.clarification}` : '',
      request.history.length ? `Recent project conversation:\n${JSON.stringify(request.history)}` : '',
      `New user message:\n${request.message}`,
    ].filter(Boolean).join('\n\n');
    return this.#complete(
      input,
      'data_model_revision',
      revisionJsonSchema,
      'Act as a careful data-modelling collaborator. Respond briefly to the user, then return the complete revised canonical model. If the user answers the open clarification, apply the answer and remove or advance that question; otherwise retain unresolved questions unless the requested change invalidates them. Preserve stable IDs and supplied facts unless the requested change requires otherwise. Keep assumptions, warnings and clarification questions explicit; never invent ambiguous relationships.',
    );
  }
}
