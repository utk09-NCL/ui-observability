import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist", "coverage", "**/node_modules", "**/dist", "playground/**/.angular"]),

  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "prefer-template": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      curly: ["error", "all"],
      "object-shorthand": ["error", "always"],
      "no-param-reassign": ["error", { props: false }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "prefer-template": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      curly: ["error", "all"],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },

  {
    files: ["tools/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        Buffer: "readonly",
        process: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
      },
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
              group: [
                "react",
                "react-dom",
                "react/*",
                "@angular/*",
                "vue",
                "svelte",
                "preact",
                "preact/*",
              ],
              message:
                "src/ is framework-agnostic. Framework code belongs in a playground example, which consumes the public API.",
            },
          ],
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "no-console": "error",
    },
  },

  {
    // Allows console calls in the dedicated developer console sink.
    files: ["src/utils/console.ts"],
    rules: {
      "no-console": "off",
    },
  },

  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/dot-notation": ["error", { allowPrivateClassPropertyAccess: true }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/unbound-method": "off",
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
              message:
                "Examples import the package by name. Deep imports prove nothing about the published API.",
            },
          ],
        },
      ],
      // An Angular shell component holds a template and no members. Without this
      // option no-extraneous-class rejects it and the fix is a filler field.
      "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }],
    },
  },

  eslintConfigPrettier,
);
