'use strict';

const { homedir } = require('node:os');
const { join } = require('node:path');

const BRIDGE_PROTOCOL_VERSION = 2;
const MAX_BRIDGE_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_BRIDGE_PROMPT_BYTES = 8 * 1024 * 1024;
const MAX_BRIDGE_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_BRIDGE_TIMEOUT_MS = 300000;
const bridgeErrors = new Set([
  'blocked', 'bridge-unavailable', 'invalid-request', 'no-permissions', 'not-found',
  'request-failed', 'request-too-large', 'response-invalid', 'response-too-large', 'timeout',
]);

function defaultBridgeConnectionFile() {
  return join(homedir(), '.data-model-agent', 'vscode-provider-v2.json');
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseBridgeMessage(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error('bridge-message-invalid'); }
  if (!isObject(value) || value.version !== BRIDGE_PROTOCOL_VERSION || typeof value.id !== 'string'
    || !/^[a-f0-9-]{16,64}$/u.test(value.id)) throw new Error('bridge-message-invalid');
  return value;
}

function parseBridgeRequest(text) {
  const value = parseBridgeMessage(text);
  if (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/u.test(value.token)) throw new Error('bridge-message-invalid');
  if (value.action === 'health' || value.action === 'models') return value;
  if (value.action !== 'complete' || value.userInitiated !== true || typeof value.model !== 'string'
    || !value.model.trim() || value.model.length > 200 || typeof value.prompt !== 'string'
    || !value.prompt || Buffer.byteLength(value.prompt, 'utf8') > MAX_BRIDGE_PROMPT_BYTES
    || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 600000) {
    throw new Error('bridge-message-invalid');
  }
  return value;
}

function parseBridgeConnection(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error('bridge-connection-invalid'); }
  if (!isObject(value) || value.version !== BRIDGE_PROTOCOL_VERSION || typeof value.socketPath !== 'string'
    || !value.socketPath || value.socketPath.length > 4096 || typeof value.token !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.token)) throw new Error('bridge-connection-invalid');
  return value;
}

function parseBridgeResponse(text, expectedId) {
  const value = parseBridgeFrame(text, expectedId);
  if ('event' in value) throw new Error('bridge-message-invalid');
  return value;
}

function parseBridgeFrame(text, expectedId) {
  const value = parseBridgeMessage(text);
  if (value.id !== expectedId) throw new Error('bridge-message-invalid');
  if (value.event === 'progress') {
    if (typeof value.phase !== 'string' || typeof value.message !== 'string') throw new Error('bridge-message-invalid');
    return value;
  }
  if (value.event === 'chunk') {
    if (typeof value.text !== 'string') throw new Error('bridge-message-invalid');
    return value;
  }
  if (typeof value.ok !== 'boolean') throw new Error('bridge-message-invalid');
  if (value.ok) {
    if (!('result' in value)) throw new Error('bridge-message-invalid');
    return value;
  }
  if (typeof value.error !== 'string' || !bridgeErrors.has(value.error)) throw new Error('bridge-message-invalid');
  return value;
}

function serializeBridgeMessage(value) {
  return `${JSON.stringify(value)}\n`;
}

module.exports = {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  MAX_BRIDGE_FRAME_BYTES,
  MAX_BRIDGE_PROMPT_BYTES,
  MAX_BRIDGE_RESPONSE_BYTES,
  defaultBridgeConnectionFile,
  parseBridgeConnection,
  parseBridgeRequest,
  parseBridgeFrame,
  parseBridgeResponse,
  serializeBridgeMessage,
};
