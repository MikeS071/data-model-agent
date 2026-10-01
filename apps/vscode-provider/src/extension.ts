import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  BRIDGE_PROTOCOL_VERSION,
  MAX_BRIDGE_FRAME_BYTES,
  MAX_BRIDGE_RESPONSE_BYTES,
  defaultBridgeConnectionFile,
  parseBridgeConnection,
  parseBridgeRequest,
  parseBridgeResponse,
  serializeBridgeMessage,
  type BridgeConnection,
  type BridgeErrorCode,
  type BridgeEvent,
  type BridgeModel,
  type BridgeRequest,
  type BridgeResponse,
} from '@data-model-agent/vscode-provider-protocol';
import * as vscode from 'vscode';

const configurationSection = 'dataModelAgent.provider';
const maximumConnections = 8;
let activeBridge: ProviderBridge | undefined;

function configuredConnectionFile() {
  return vscode.workspace.getConfiguration(configurationSection).get<string>('connectionFile')?.trim()
    || defaultBridgeConnectionFile();
}

function configuredModel() {
  return vscode.workspace.getConfiguration(configurationSection).get<string>('model')?.trim() || 'gpt-5.6-sol';
}

function publicModel(model: vscode.LanguageModelChat): BridgeModel {
  return {
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    family: model.family,
    version: model.version,
    maxInputTokens: model.maxInputTokens,
  };
}

function bridgeError(error: unknown): BridgeErrorCode {
  if (error instanceof Error && error.name === 'ChatQuotaExceeded') return 'blocked';
  if (error instanceof vscode.LanguageModelError) {
    if (error.code === 'NoPermissions') return 'no-permissions';
    if (error.code === 'NotFound') return 'not-found';
    if (error.code === 'Blocked') return 'blocked';
  }
  if (error instanceof Error && error.message === 'response-too-large') return 'response-too-large';
  if (error instanceof Error && error.message === 'response-invalid') return 'response-invalid';
  if (error instanceof Error && error.message === 'request-too-large') return 'request-too-large';
  if (error instanceof Error && error.message === 'request-timeout') return 'timeout';
  if (error instanceof Error && error.message === 'model-not-found') return 'not-found';
  return 'request-failed';
}

function errorMetadata(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  return {
    name: error instanceof Error ? error.name : typeof error,
    languageModelCode: error instanceof vscode.LanguageModelError ? error.code : null,
    causeName: cause instanceof Error ? cause.name : null,
    causeCode: cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : null,
    causeStatus: cause && typeof cause === 'object' && 'status' in cause && typeof cause.status === 'number' ? cause.status : null,
  };
}

function readConnection(path: string): BridgeConnection | undefined {
  if (!existsSync(path)) return undefined;
  try { return parseBridgeConnection(readFileSync(path, 'utf8')); }
  catch { return undefined; }
}

function writeConnection(path: string, connection: BridgeConnection) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  writeFileSync(pending, `${JSON.stringify(connection)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') chmodSync(pending, 0o600);
  renameSync(pending, path);
}

function randomSocketPath(connectionFile: string) {
  const suffix = randomUUID();
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\data-model-agent-vscode-provider-v2-${suffix}`
    : join(dirname(connectionFile), `vscode-provider-v2-${suffix}.sock`);
}

function requestIdFrom(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as { id?: unknown };
    return typeof value.id === 'string' && /^[a-f0-9-]{16,64}$/u.test(value.id) ? value.id : undefined;
  } catch {
    return undefined;
  }
}

function tokenFrom(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as { token?: unknown };
    return typeof value.token === 'string' ? value.token : undefined;
  } catch {
    return undefined;
  }
}

function probe(connection: BridgeConnection): Promise<boolean> {
  return new Promise(resolve => {
    const id = randomUUID();
    const socket = createConnection(connection.socketPath);
    socket.setEncoding('utf8');
    socket.setTimeout(1500);
    let buffer = '';
    let finished = false;
    const finish = (ready: boolean) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(ready);
    };
    socket.on('connect', () => socket.write(serializeBridgeMessage({
      version: BRIDGE_PROTOCOL_VERSION, id, token: connection.token, action: 'health',
    })));
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(parseBridgeResponse(buffer.slice(0, newline), id).ok); }
      catch { finish(false); }
    });
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

class ProviderBridge implements vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #output: vscode.LogOutputChannel;
  readonly #status: vscode.StatusBarItem;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  #connection: BridgeConnection | undefined;
  #connectionFile = '';
  #ownsConnection = false;
  #operation: Promise<void> = Promise.resolve();

  constructor(context: vscode.ExtensionContext, output: vscode.LogOutputChannel, status: vscode.StatusBarItem) {
    this.#context = context;
    this.#output = output;
    this.#status = status;
  }

  start() {
    const operation = () => this.#start();
    this.#operation = this.#operation.then(operation, operation);
    return this.#operation;
  }

  stop() {
    const operation = () => this.#stop();
    this.#operation = this.#operation.then(operation, operation);
    return this.#operation;
  }

  ensureOwner() {
    return this.#ownsConnection ? Promise.resolve() : this.start();
  }

  async showStatus() {
    const connection = readConnection(configuredConnectionFile());
    const ready = connection ? await probe(connection) : false;
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const selected = models.find(model => model.id === configuredModel());
    const message = ready && selected
      ? `VS Code provider is ready. Model ${selected.id} is available.`
      : ready ? `VS Code provider is ready, but model ${configuredModel()} is unavailable.`
        : 'VS Code provider bridge is not running.';
    await vscode.window.showInformationMessage(message);
  }

  dispose() {
    void this.stop();
  }

  async #start() {
    await this.#stop();
    this.#connectionFile = configuredConnectionFile();
    const existing = readConnection(this.#connectionFile);
    if (existing && await probe(existing)) {
      this.#connection = existing;
      this.#ownsConnection = false;
      this.#output.info(`Using provider bridge owned by another VS Code window at ${existing.socketPath}`);
      this.#setStatus('shared');
      return;
    }

    if (existing && process.platform !== 'win32' && existing.socketPath.startsWith(`${dirname(this.#connectionFile)}/`)) {
      const stat = statSync(existing.socketPath, { throwIfNoEntry: false });
      if (stat?.isSocket()) rmSync(existing.socketPath);
    }

    const connection: BridgeConnection = {
      version: BRIDGE_PROTOCOL_VERSION,
      socketPath: randomSocketPath(this.#connectionFile),
      token: randomBytes(32).toString('hex'),
    };
    const server = createServer(socket => this.#accept(socket));
    this.#server = server;
    server.on('error', error => {
      this.#output.error(`Bridge server error: ${error.message}`);
      this.#setStatus('error');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(connection.socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.#server = undefined;
      if (server.listening) server.close();
      const current = readConnection(this.#connectionFile);
      if (current && await probe(current)) {
        this.#connection = current;
        this.#ownsConnection = false;
        this.#setStatus('shared');
        return;
      }
      throw error;
    }
    if (process.platform !== 'win32') chmodSync(connection.socketPath, 0o600);
    writeConnection(this.#connectionFile, connection);
    this.#connection = connection;
    this.#ownsConnection = true;
    this.#output.info(`Bridge ready at ${connection.socketPath}`);
    this.#setStatus('ready');
  }

  async #stop() {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    const connection = this.#connection;
    if (this.#ownsConnection && connection) {
      const current = readConnection(this.#connectionFile);
      if (current?.token === connection.token) rmSync(this.#connectionFile, { force: true });
      if (process.platform !== 'win32') {
        const stat = statSync(connection.socketPath, { throwIfNoEntry: false });
        if (stat?.isSocket()) rmSync(connection.socketPath);
      }
    }
    this.#connection = undefined;
    this.#ownsConnection = false;
    this.#setStatus('stopped');
  }

  #setStatus(state: 'ready' | 'shared' | 'error' | 'stopped') {
    this.#status.text = state === 'ready' || state === 'shared' ? '$(radio-tower) Model Foundry provider'
      : state === 'error' ? '$(error) Model Foundry provider' : '$(circle-slash) Model Foundry provider';
    this.#status.tooltip = state === 'ready' ? 'This window owns the local provider bridge'
      : state === 'shared' ? 'Another VS Code window owns the local provider bridge'
        : `Provider bridge ${state}`;
    this.#status.show();
  }

  #accept(socket: Socket) {
    if (this.#sockets.size >= maximumConnections) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(610000);
    let buffer = '';
    let bytes = 0;
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_BRIDGE_FRAME_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      void this.#handle(buffer.slice(0, newline), socket);
    });
    socket.on('timeout', () => socket.destroy(new Error('socket-timeout')));
    socket.on('error', error => this.#output.warn(`Bridge connection error: ${error.message}`));
    socket.on('close', () => this.#sockets.delete(socket));
  }

  async #handle(line: string, socket: Socket) {
    const id = requestIdFrom(line);
    const connection = this.#connection;
    if (!id || !connection || tokenFrom(line) !== connection.token) {
      socket.destroy();
      return;
    }
    let request: BridgeRequest;
    try { request = parseBridgeRequest(line); }
    catch {
      this.#write(socket, { version: BRIDGE_PROTOCOL_VERSION, id, ok: false, error: 'invalid-request' });
      return;
    }
    try {
      const result = request.action === 'health' ? {
        status: 'ready',
        extensionVersion: this.#context.extension.packageJSON.version as string,
        vscodeVersion: vscode.version,
        socketPath: connection.socketPath,
        configuredModel: configuredModel(),
      } : request.action === 'models' ? {
        models: (await vscode.lm.selectChatModels({ vendor: 'copilot' })).map(publicModel),
      } : await this.#complete(request, socket);
      this.#write(socket, { version: BRIDGE_PROTOCOL_VERSION, id: request.id, ok: true, result });
    } catch (error) {
      const code = bridgeError(error);
      this.#output.warn(`Bridge request ${request.action} failed: ${code} ${JSON.stringify(errorMetadata(error))}`);
      this.#write(socket, { version: BRIDGE_PROTOCOL_VERSION, id: request.id, ok: false, error: code });
    }
  }

  async #complete(request: Extract<BridgeRequest, { action: 'complete' }>, socket: Socket) {
    this.#event(socket, { version: BRIDGE_PROTOCOL_VERSION, id: request.id, event: 'progress', phase: 'selecting-model', message: `Selecting ${request.model}…` });
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', id: request.model });
    const model = models[0];
    if (!model) throw new Error('model-not-found');
    this.#event(socket, { version: BRIDGE_PROTOCOL_VERSION, id: request.id, event: 'progress', phase: 'preparing', message: 'Preparing the model context…' });
    const cancellation = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => cancellation.cancel(), request.timeoutMs);
    const close = () => cancellation.cancel();
    socket.once('close', close);
    try {
      const tokens = await model.countTokens(request.prompt, cancellation.token);
      if (tokens > model.maxInputTokens) throw new Error('request-too-large');
      this.#event(socket, { version: BRIDGE_PROTOCOL_VERSION, id: request.id, event: 'progress', phase: 'generating', message: `${model.name} is building the model…` });
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(request.prompt)],
        { justification: 'Generate or revise a data model after an explicit user action in the local Model Foundry application.' },
        cancellation.token,
      );
      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
        if (Buffer.byteLength(text, 'utf8') > MAX_BRIDGE_RESPONSE_BYTES) throw new Error('response-too-large');
        this.#event(socket, { version: BRIDGE_PROTOCOL_VERSION, id: request.id, event: 'chunk', text: fragment });
      }
      if (!text.trim()) throw new Error('response-invalid');
      this.#event(socket, { version: BRIDGE_PROTOCOL_VERSION, id: request.id, event: 'progress', phase: 'validating', message: 'Validating the completed model…' });
      return { text, model: publicModel(model) };
    } catch (error) {
      if (cancellation.token.isCancellationRequested && !socket.destroyed) throw new Error('request-timeout', { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
      socket.off('close', close);
      cancellation.dispose();
    }
  }

  #write(socket: Socket, response: BridgeResponse) {
    if (!socket.destroyed) socket.end(serializeBridgeMessage(response));
  }

  #event(socket: Socket, event: BridgeEvent) {
    if (!socket.destroyed) socket.write(serializeBridgeMessage(event));
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Data Model Agent Provider', { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'dataModelAgent.provider.showStatus';
  const bridge = new ProviderBridge(context, output, status);
  activeBridge = bridge;
  context.subscriptions.push(output, status, bridge);
  context.subscriptions.push(vscode.commands.registerCommand('dataModelAgent.provider.restart', async () => {
    try {
      await bridge.start();
      await vscode.window.showInformationMessage('Data Model Agent provider bridge restarted.');
    } catch (error) {
      output.error(`Bridge restart failed: ${error instanceof Error ? error.message : 'unknown'}`);
      await vscode.window.showErrorMessage('Data Model Agent provider bridge could not start. See the extension output.');
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('dataModelAgent.provider.showStatus', () => bridge.showStatus()));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(configurationSection)) void bridge.start().catch(error => {
      output.error(`Bridge configuration reload failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  }));
  context.subscriptions.push(vscode.window.onDidChangeWindowState(event => {
    if (event.focused) void bridge.ensureOwner().catch(error => output.error(`Bridge ownership check failed: ${error instanceof Error ? error.message : 'unknown'}`));
  }));
  try { await bridge.start(); }
  catch (error) {
    output.error(`Bridge activation failed: ${error instanceof Error ? error.message : 'unknown'}`);
    await vscode.window.showErrorMessage('Data Model Agent provider bridge could not start. See the extension output.');
  }
}

export function deactivate() {
  const bridge = activeBridge;
  activeBridge = undefined;
  return bridge?.stop();
}
