import type { NextConfig } from 'next';

// The e2e stack builds into its own folder so it never touches a running `next dev`.
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // The shared tokens package ships TypeScript source.
  transpilePackages: ['design-tokens'],
};

export default nextConfig;
