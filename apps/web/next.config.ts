import type { NextConfig } from 'next';

// The e2e stack builds into its own folder so it never touches a running `next dev`.
const nextConfig: NextConfig = { distDir: process.env.NEXT_DIST_DIR ?? '.next' };

export default nextConfig;
