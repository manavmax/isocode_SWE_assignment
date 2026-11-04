import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', '.tmp-smoke'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      ...reactHooks.configs.recommended.rules
    }
  },
  {
    files: ['src/server/**', 'src/shared/**', 'api/**', 'scripts/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportDeclaration[source.value=/^\\./][source.value!=/\\.(mjs|cjs|jsx?|json)$/]",
          message: 'Relative imports here need an explicit .js specifier so plain Node ESM can resolve them (see docs/adr/0004-db-driver.md and the vercel fix)'
        },
        {
          selector: "ExportNamedDeclaration[source.value=/^\\./][source.value!=/\\.(mjs|cjs|jsx?|json)$/]",
          message: 'Relative re-exports here need an explicit .js specifier so plain Node ESM can resolve them'
        },
        {
          selector: "ExportAllDeclaration[source.value=/^\\./][source.value!=/\\.(mjs|cjs|jsx?|json)$/]",
          message: 'Relative re-exports here need an explicit .js specifier so plain Node ESM can resolve them'
        }
      ]
    }
  }
);
