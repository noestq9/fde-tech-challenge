import type { NextConfig } from 'next';

const config: NextConfig = {
  // Twin is read only from the server; nothing about the gateway reaches the browser bundle.
  poweredByHeader: false,
  // Self-contained server for the Docker image (Railway).
  output: 'standalone',
  outputFileTracingRoot: process.cwd(),
};

export default config;
