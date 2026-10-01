export declare const BRIDGE_PROTOCOL_VERSION: 2;
export declare const MAX_BRIDGE_FRAME_BYTES: number;
export declare const MAX_BRIDGE_PROMPT_BYTES: number;
export declare const MAX_BRIDGE_RESPONSE_BYTES: number;
export declare const DEFAULT_BRIDGE_TIMEOUT_MS: number;

export interface BridgeConnection {
  version: 2;
  socketPath: string;
  token: string;
}

export interface BridgeModel {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number;
}

export interface BridgeHealthResult {
  status: 'ready';
  extensionVersion: string;
  vscodeVersion: string;
  socketPath: string;
  configuredModel: string;
}

export type BridgeRequest =
  | { version: 2; id: string; token: string; action: 'health' }
  | { version: 2; id: string; token: string; action: 'models' }
  | {
    version: 2;
    id: string;
    token: string;
    action: 'complete';
    model: string;
    prompt: string;
    timeoutMs: number;
    userInitiated: true;
  };

export type BridgeErrorCode =
  | 'blocked'
  | 'bridge-unavailable'
  | 'invalid-request'
  | 'no-permissions'
  | 'not-found'
  | 'request-failed'
  | 'request-too-large'
  | 'response-invalid'
  | 'response-too-large'
  | 'timeout';

export type BridgeResponse =
  | { version: 2; id: string; ok: true; result: unknown }
  | { version: 2; id: string; ok: false; error: BridgeErrorCode };

export type BridgeEvent =
  | { version: 2; id: string; event: 'progress'; phase: string; message: string }
  | { version: 2; id: string; event: 'chunk'; text: string };

export type BridgeFrame = BridgeResponse | BridgeEvent;

export declare function defaultBridgeConnectionFile(): string;
export declare function parseBridgeConnection(text: string): BridgeConnection;
export declare function parseBridgeRequest(text: string): BridgeRequest;
export declare function parseBridgeFrame(text: string, expectedId: string): BridgeFrame;
export declare function parseBridgeResponse(text: string, expectedId: string): BridgeResponse;
export declare function serializeBridgeMessage(value: BridgeRequest | BridgeFrame): string;
