import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  experimental: {
    useTypeScriptCli: false,
  },
};

export default config;
