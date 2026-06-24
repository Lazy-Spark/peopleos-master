import path from "node:path";
import { fileURLToPath } from "node:url";

// apps/web absolute dir — used to anchor the "@/" path alias so a production
// `next build` resolves it regardless of how the inherited tsconfig baseUrl
// (defined in the repo-root tsconfig.base.json) would otherwise resolve it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @peopleos/schemas is a workspace TS package consumed as source; let Next
  // transpile it rather than expecting a pre-built dist.
  transpilePackages: ["@peopleos/schemas"],
  experimental: {
    // Keep typed routes off in this lean skeleton; enable later if desired.
    typedRoutes: false,
  },
  // Don't let the repo's pre-existing type debt / lint warnings block a
  // production container build (the API similarly runs via tsx, not a clean tsc).
  // A real release pipeline should re-enable these once the debt is paid down.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  webpack: (config) => {
    // Resolve "@/..." to apps/web absolutely. The alias key "@" only matches "@/"
    // requests, so "@peopleos/schemas" is unaffected.
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@": __dirname,
    };
    // The shared @peopleos/schemas package is consumed as TS *source* (via
    // transpilePackages) and uses explicit ".js" extensions in its relative
    // imports (TS NodeNext/ESM style, e.g. `export * from "./common.js"`).
    // Teach webpack to also try ".ts"/".tsx" when a ".js" import has no ".js" file.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".js", ".ts", ".tsx"],
      ".mjs": [".mjs", ".mts"],
      ".cjs": [".cjs", ".cts"],
    };
    return config;
  },
};

export default nextConfig;
