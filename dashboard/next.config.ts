import type { NextConfig } from 'next';

const config: NextConfig = {
  // Twin is read only from the server; nothing about the gateway reaches the browser bundle.
  poweredByHeader: false,
};

export default config;
