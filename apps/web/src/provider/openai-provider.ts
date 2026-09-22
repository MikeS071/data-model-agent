import type { GenerationRequest, ModelProvider } from './model-provider';

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

interface ProviderOptions {
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function outputText(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('provider-output-missing');
  const response = value as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
  for (const item of response.output ?? []) for (const content of item.content ?? []) {
    if (item.type === 'message' && content.type === 'output_text' && typeof content.text === 'string') return content.text;
  }
  throw new Error('provider-output-missing');
}

export class OpenAIModelProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetcher: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ProviderOptions) {
    if (!options.apiKey || !options.model) throw new Error('provider-not-configured');
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#fetcher = options.fetcher ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 45_000;
  }

  static fromEnvironment(environment: Record<string, string | undefined> = process.env) {
    const apiKey = environment.OPENAI_API_KEY, model = environment.OPENAI_MODEL;
    if (!apiKey || !model) throw new Error('provider-not-configured');
    return new OpenAIModelProvider({ apiKey, model });
  }

  async generate(request: GenerationRequest): Promise<unknown> {
    const sources = request.sources.map(source => `--- ${source.name} (${source.kind}) ---\n${source.content}`).join('\n\n');
    const input = [
      `Requirements:\n${request.requirements}`,
      sources ? `Source artifacts:\n${sources}` : '',
      request.currentModel ? `Current canonical model:\n${JSON.stringify(request.currentModel)}` : '',
      request.clarification ? `Latest clarification:\n${request.clarification}` : '',
    ].filter(Boolean).join('\n\n');
    let response: Response;
    try {
      response = await this.#fetcher('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.#timeoutMs),
        body: JSON.stringify({
          model: this.#model,
          store: false,
          instructions: 'Create a conservative data-model draft. Preserve supplied facts, label assumptions, emit warnings, and ask clarification questions instead of inventing ambiguous relationships.',
          input,
          text: { format: { type: 'json_schema', name: 'data_model_generation', strict: true, schema: generationJsonSchema } },
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error('provider-timeout');
      throw new Error('provider-unavailable');
    }
    if (response.status === 429) throw new Error('provider-rate-limited');
    if (!response.ok) throw new Error('provider-failed');
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error('provider-output-invalid'); }
    try { return JSON.parse(outputText(body)); } catch (error) {
      if (error instanceof Error && error.message === 'provider-output-missing') throw error;
      throw new Error('provider-output-invalid');
    }
  }
}
