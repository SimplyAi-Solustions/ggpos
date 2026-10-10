import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
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
    // shadcn components export their cva variants next to the component.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // TanStack Router file routes export a `Route` and keep their component
    // unexported, which is what lets `autoCodeSplitting` lift the component
    // into its own chunk. Exporting it to satisfy this rule (even with
    // allowExportNames: ['Route']) pins every screen into the entry bundle,
    // so the rule is off here instead. The router plugin injects its own
    // HMR handler for these files, so fast refresh still works.
    files: ['src/routes/**/*.{ts,tsx}', 'src/routeTree.gen.ts'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
