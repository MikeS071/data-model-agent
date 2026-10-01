import { join } from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(process.cwd(), '../..'),
  outputFileTracingIncludes: {
    '/*': ['../../node_modules/.pnpm/@github+copilot-sdk-*/node_modules/@github/copilot-sdk-*/**/*'],
  },
  serverExternalPackages: ['@github/copilot-sdk'],
  experimental: {
    useTypeScriptCli: false,
  },
};

export default config;
