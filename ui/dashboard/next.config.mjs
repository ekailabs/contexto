import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Monorepo: tell Next.js where the workspace root is so it can resolve packages
  outputFileTracingRoot: resolve(__dirname, '../..'),
};

export default nextConfig;
