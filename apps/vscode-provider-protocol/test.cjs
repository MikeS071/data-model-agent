'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const {
  BRIDGE_PROTOCOL_VERSION,
  MAX_BRIDGE_PROMPT_BYTES,
  parseBridgeConnection,
  parseBridgeFrame,
  parseBridgeRequest,
  parseBridgeResponse,
  serializeBridgeMessage,
} = require('./index.js');

const token = 'a'.repeat(64);

test('round-trips authenticated completion requests', () => {
  const request = {
    version: BRIDGE_PROTOCOL_VERSION,
    id: randomUUID(),
    token,
    action: 'complete',
    model: 'gpt-5.6-sol',
    prompt: 'Return JSON.',
    timeoutMs: 120000,
    userInitiated: true,
  };
  assert.deepEqual(parseBridgeRequest(serializeBridgeMessage(request).trim()), request);
});

test('rejects requests without local authentication or explicit user initiation', () => {
  const base = {
    version: BRIDGE_PROTOCOL_VERSION,
    id: randomUUID(),
    token,
    action: 'complete',
    model: 'gpt-5.6-sol',
    prompt: 'Return JSON.',
    timeoutMs: 120000,
    userInitiated: true,
  };
  assert.throws(() => parseBridgeRequest(JSON.stringify({ ...base, token: '' })), /bridge-message-invalid/u);
  assert.throws(() => parseBridgeRequest(JSON.stringify({ ...base, userInitiated: false })), /bridge-message-invalid/u);
  assert.throws(() => parseBridgeRequest(JSON.stringify({ ...base, prompt: 'x'.repeat(MAX_BRIDGE_PROMPT_BYTES + 1) })), /bridge-message-invalid/u);
});

test('validates connection records and correlated responses', () => {
  const connection = { version: BRIDGE_PROTOCOL_VERSION, socketPath: '\\\\.\\pipe\\random', token };
  assert.deepEqual(parseBridgeConnection(JSON.stringify(connection)), connection);
  const id = randomUUID();
  const response = { version: BRIDGE_PROTOCOL_VERSION, id, ok: false, error: 'invalid-request' };
  assert.deepEqual(parseBridgeResponse(JSON.stringify(response), id), response);
  assert.throws(() => parseBridgeResponse(JSON.stringify(response), randomUUID()), /bridge-message-invalid/u);
  assert.throws(() => parseBridgeResponse(JSON.stringify({ ...response, error: 'unknown' }), id), /bridge-message-invalid/u);
});

test('parses progress and streamed text frames without accepting them as final responses', () => {
  const id = randomUUID();
  const progress = { version: BRIDGE_PROTOCOL_VERSION, id, event: 'progress', phase: 'generating', message: 'Generating model…' };
  const chunk = { version: BRIDGE_PROTOCOL_VERSION, id, event: 'chunk', text: '{"model":' };
  assert.deepEqual(parseBridgeFrame(JSON.stringify(progress), id), progress);
  assert.deepEqual(parseBridgeFrame(JSON.stringify(chunk), id), chunk);
  assert.throws(() => parseBridgeResponse(JSON.stringify(progress), id), /bridge-message-invalid/u);
});
