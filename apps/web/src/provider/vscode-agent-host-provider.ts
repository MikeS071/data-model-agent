import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  MAX_BRIDGE_FRAME_BYTES,
  defaultBridgeConnectionFile,
  parseBridgeConnection,
  parseBridgeFrame,
  parseBridgeResponse,
  serializeBridgeMessage,
  type BridgeEvent,
  type BridgeConnection,
  type BridgeRequest,
  type BridgeResponse,
} from '@data-model-agent/vscode-provider-protocol';
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

interface VSCodeAgentHostProviderOptions {
  model: string;
  connectionFile?: string;
  timeoutMs?: number;
  connection?: () => BridgeConnection;
  request?: (request: BridgeRequest, connection: BridgeConnection, onEvent?: (event: BridgeEvent) => void, signal?: AbortSignal) => Promise<BridgeResponse>;
}

function bridgeRequest(request: BridgeRequest, connection: BridgeConnection, onEvent?: (event: BridgeEvent) => void, signal?: AbortSignal): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(connection.socketPath);
    socket.setEncoding('utf8');
    socket.setTimeout('timeoutMs' in request ? request.timeoutMs + 5000 : 10000);
    let buffer = '';
    let bytes = 0;
    let settled = false;
    const abort = () => finish(new Error('bridge-aborted'));
    const finish = (error?: Error, response?: BridgeResponse) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    if (signal?.aborted) finish(new Error('bridge-aborted'));
    else signal?.addEventListener('abort', abort, { once: true });
    socket.on('connect', () => socket.write(serializeBridgeMessage(request)));
    socket.on('data', chunk => {
      buffer += chunk;
      bytes = Buffer.byteLength(buffer, 'utf8');
      if (bytes > MAX_BRIDGE_FRAME_BYTES) {
        finish(new Error('bridge-response-too-large'));
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0 && !settled) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        bytes = Buffer.byteLength(buffer, 'utf8');
        try {
          const frame = parseBridgeFrame(line, request.id);
          if ('event' in frame) onEvent?.(frame);
          else finish(undefined, parseBridgeResponse(line, request.id));
        } catch (error) {
          finish(error instanceof Error ? error : new Error('bridge-message-invalid'));
        }
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('timeout', () => finish(new Error('bridge-timeout')));
    socket.on('error', error => finish(error));
    socket.on('close', () => {
      if (!settled) finish(new Error('bridge-closed'));
    });
  });
}

function providerError(error: string | Error) {
  const code = typeof error === 'string' ? error : error.message;
  if (code === 'no-permissions') return new Error('provider-not-configured');
  if (code === 'not-found' || code === 'invalid-request' || code === 'request-too-large') return new Error('provider-config-invalid');
  if (code === 'blocked') return new Error('provider-rate-limited');
  if (code === 'timeout' || code === 'bridge-timeout') return new Error('provider-timeout');
  if (code === 'response-invalid' || code === 'response-too-large' || code === 'bridge-response-too-large'
    || code === 'bridge-message-invalid') return new Error('provider-output-invalid');
  return new Error('provider-unavailable');
}

function structuredPrompt(instructions: string, input: string, schema: object) {
  return [
    instructions,
    'This request was initiated by the user in a local data-modelling application.',
    'Do not call tools. Return exactly one JSON value with no Markdown fence or surrounding commentary.',
    `The JSON must conform to this schema:\n${JSON.stringify(schema)}`,
    input,
  ].join('\n\n');
}

function parseStructuredResponse(text: string) {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
    : trimmed;
  return JSON.parse(unfenced);
}

export class VSCodeAgentHostProvider implements ModelProvider {
  readonly #model: string;
  readonly #connectionFile: string;
  readonly #timeoutMs: number;
  readonly #connection: () => BridgeConnection;
  readonly #request: (request: BridgeRequest, connection: BridgeConnection, onEvent?: (event: BridgeEvent) => void, signal?: AbortSignal) => Promise<BridgeResponse>;

  constructor(options: VSCodeAgentHostProviderOptions) {
    this.#model = options.model.trim();
    this.#connectionFile = options.connectionFile?.trim() || defaultBridgeConnectionFile();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    this.#connection = options.connection ?? (() => parseBridgeConnection(readFileSync(this.#connectionFile, 'utf8')));
    this.#request = options.request ?? bridgeRequest;
  }

  static fromEnvironment(
    environment: Record<string, string | undefined> = process.env,
    runtime: Pick<VSCodeAgentHostProviderOptions, 'request'> = {},
  ) {
    return new VSCodeAgentHostProvider({
      model: environment.VSCODE_AGENT_HOST_MODEL ?? '',
      connectionFile: environment.VSCODE_AGENT_HOST_CONNECTION_FILE,
      timeoutMs: environmentInteger(environment.VSCODE_AGENT_HOST_TIMEOUT_MS, DEFAULT_BRIDGE_TIMEOUT_MS, 1000, 600000),
      ...runtime,
    });
  }

  async listModels() {
    let connection: BridgeConnection;
    try { connection = this.#connection(); }
    catch (error) { throw providerError(error instanceof Error ? error : new Error('bridge-connection-invalid')); }
    const request: BridgeRequest = {
      version: BRIDGE_PROTOCOL_VERSION,
      id: randomUUID(),
      token: connection.token,
      action: 'models',
    };
    let response: BridgeResponse;
    try { response = await this.#request(request, connection); }
    catch (error) { throw providerError(error instanceof Error ? error : new Error('bridge-unavailable')); }
    if (!response.ok) throw providerError(response.error);
    const result = response.result as { models?: unknown };
    if (!Array.isArray(result?.models)) throw new Error('provider-output-invalid');
    return result.models.flatMap(model => model && typeof model === 'object'
      && 'id' in model && typeof model.id === 'string'
      && 'name' in model && typeof model.name === 'string'
      ? [{ id: model.id, name: model.name }] : []);
  }

  async #complete(prompt: string, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<unknown> {
    if (!this.#model) throw new Error('provider-not-configured');
    onProgress?.({ phase: 'connecting', message: 'Connecting to the VS Code provider bridge…' });
    let connection: BridgeConnection;
    try { connection = this.#connection(); }
    catch (error) { throw providerError(error instanceof Error ? error : new Error('bridge-connection-invalid')); }
    const request: BridgeRequest = {
      version: BRIDGE_PROTOCOL_VERSION,
      id: randomUUID(),
      token: connection.token,
      action: 'complete',
      model: this.#model,
      prompt,
      timeoutMs: this.#timeoutMs,
      userInitiated: true,
    };
    let response: BridgeResponse;
    try {
      response = await this.#request(request, connection, event => {
        if (event.event === 'chunk') {
          onProgress?.({ phase: 'receiving', message: 'Receiving live model output…', transcriptDelta: event.text });
        } else {
          onProgress?.({
            phase: event.phase === 'selecting-model' ? 'selecting-model'
              : event.phase === 'preparing' ? 'preparing'
                : event.phase === 'validating' ? 'validating' : 'generating',
            message: event.message,
          });
        }
      }, signal);
    }
    catch (error) { throw providerError(error instanceof Error ? error : new Error('bridge-unavailable')); }
    if (!response.ok) throw providerError(response.error);
    const result = response.result as { text?: unknown };
    if (!result || typeof result !== 'object' || typeof result.text !== 'string') throw new Error('provider-output-invalid');
    onProgress?.({ phase: 'validating', message: 'Validating the completed model…' });
    try { return parseStructuredResponse(result.text); }
    catch (error) { throw new Error('provider-output-invalid', { cause: error }); }
  }

  generate(request: GenerationRequest, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<unknown> {
    return this.#complete(structuredPrompt(GENERATION_INSTRUCTIONS, generationInput(request), generationJsonSchema), onProgress, signal);
  }

  revise(request: RevisionRequest, onProgress?: ProviderProgressHandler, signal?: AbortSignal): Promise<unknown> {
    return this.#complete(structuredPrompt(REVISION_INSTRUCTIONS, revisionInput(request), revisionJsonSchema), onProgress, signal);
  }
}
