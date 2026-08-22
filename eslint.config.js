// eslint.config.js
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist", "coverage", "**/node_modules", "**/dist", "playground/**/.angular"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react-dom", "react/*", "@angular/*", "vue", "svelte", "preact", "preact/*"],
              message:
                "src/ is framework-agnostic. Framework code belongs in a playground example, which consumes the public API.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "playground/react/**/*",
      "playground/angular/**/*",
      "playground/microfrontend/**/*",
      "playground/openfin/**/*",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/src/*", "**/../src", "ui-observability/dist/*"],
              message: "Examples import the package by name. Deep imports prove nothing about the published API.",
            },
          ],
        },
      ],
    },
  },
);
