import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import manifest from "./manifest.config.js";

/**
 * Vite build for the MV3 extension.
 *
 * @crxjs/vite-plugin reads `manifest.config.ts`, bundles the background worker,
 * content script, side-panel, and options pages, and emits a load-unpackable
 * `dist/` with a generated manifest.json. Run `pnpm --filter @peopleos/extension build`,
 * then load `apps/extension/dist` via chrome://extensions → "Load unpacked".
 *
 * We alias `@peopleos/schemas` to the workspace source so the extension shares the
 * FROZEN Zod contracts (types only at runtime where we re-validate API responses).
 */
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@peopleos/schemas": resolve(__dirname, "../../packages/schemas/src/index.ts"),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // MV3 service workers + content scripts must not be split into shared chunks
    // that the worker cannot import; crxjs handles entry wiring, keep modulepreload off.
    modulePreload: false,
  },
  server: {
    port: 5183,
    strictPort: true,
    hmr: { port: 5183 },
  },
});
