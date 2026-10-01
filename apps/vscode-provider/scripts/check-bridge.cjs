'use strict';

const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createConnection } = require('node:net');
const {
  BRIDGE_PROTOCOL_VERSION,
  defaultBridgeConnectionFile,
  parseBridgeConnection,
  parseBridgeFrame,
  parseBridgeResponse,
  serializeBridgeMessage,
} = require('@data-model-agent/vscode-provider-protocol');

const id = randomUUID();
const action = process.argv[2] === 'models' ? 'models' : process.argv[2] === 'complete' ? 'complete' : 'health';
const connectionFile = process.env.VSCODE_AGENT_HOST_CONNECTION_FILE?.trim() || defaultBridgeConnectionFile();
const connection = parseBridgeConnection(readFileSync(connectionFile, 'utf8'));
const socket = createConnection(connection.socketPath);
socket.setEncoding('utf8');
socket.setTimeout(10000);
let buffer = '';
socket.on('connect', () => socket.write(serializeBridgeMessage(action === 'complete' ? {
  version: BRIDGE_PROTOCOL_VERSION,
  id,
  token: connection.token,
  action,
  model: process.env.VSCODE_AGENT_HOST_MODEL?.trim() || 'gpt-5.6-sol',
  prompt: 'Return exactly this JSON object and nothing else: {"ok":true}',
  timeoutMs: 120000,
  userInitiated: true,
} : { version: BRIDGE_PROTOCOL_VERSION, id, token: connection.token, action })));
socket.on('data', chunk => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const frame = parseBridgeFrame(line, id);
      if ('event' in frame) {
        if (frame.event === 'progress') console.error(`[${frame.phase}] ${frame.message}`);
      } else {
        const response = parseBridgeResponse(line, id);
        console.log(JSON.stringify(response));
        if (!response.ok) process.exitCode = 1;
        socket.end();
        return;
      }
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error('bridge-message-invalid'));
      return;
    }
    newline = buffer.indexOf('\n');
  }
});
socket.on('timeout', () => socket.destroy(new Error('bridge-timeout')));
socket.on('error', error => {
  console.error(`Bridge check failed: ${error.message}`);
  process.exitCode = 1;
});
