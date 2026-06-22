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
};

export default nextConfig;
