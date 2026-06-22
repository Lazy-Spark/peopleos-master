// @ts-check
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config for the extension. Type-aware rules with the strict preset;
 * `no-explicit-any` is enforced (the subtree must contain no `any`).
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".turbo/**"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
