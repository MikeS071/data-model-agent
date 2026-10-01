'use strict';

const { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const target = join(homedir(), '.vscode', 'extensions', `${manifest.publisher}.${manifest.name}-${manifest.version}`);

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, 'out', 'node_modules', '@data-model-agent', 'vscode-provider-protocol'), { recursive: true });
cpSync(join(root, 'out', 'extension.js'), join(target, 'out', 'extension.js'));
cpSync(
  join(root, '..', 'vscode-provider-protocol', 'index.js'),
  join(target, 'out', 'node_modules', '@data-model-agent', 'vscode-provider-protocol', 'index.js'),
);
writeFileSync(
  join(target, 'out', 'node_modules', '@data-model-agent', 'vscode-provider-protocol', 'package.json'),
  `${JSON.stringify({ name: '@data-model-agent/vscode-provider-protocol', version: manifest.version, main: 'index.js' }, null, 2)}\n`,
);
writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Installed ${manifest.displayName} ${manifest.version} to ${target}`);
