import js from "@eslint/js"
import globals from "globals"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Kit primitives export their variant helpers next to the component.
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    // TanStack Router file routes export a `Route` and keep their component
    // unexported, so `autoCodeSplitting` can lift it into its own chunk.
    files: ["src/routes/**/*.{ts,tsx}", "src/routeTree.gen.ts"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "public/**/*.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
])
