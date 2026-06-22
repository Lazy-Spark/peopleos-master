/**
 * `tailwindcss-animate` does not ship type declarations. The plugin is a Tailwind
 * PluginCreator; we type it loosely so the import in tailwind.config.ts resolves
 * under strict mode without pulling in `any` at any call site.
 */
declare module "tailwindcss-animate" {
  import type { PluginCreator } from "tailwindcss/types/config";
  const plugin: PluginCreator;
  export default plugin;
}
