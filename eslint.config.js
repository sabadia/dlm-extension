import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'coverage/**',
      'spikes/**',
      'src/lib/api/schema.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Playwright's own idioms: fixtures are destructured with `{}` when they use nothing, and `test.setTimeout` is
    // called as a method.
    files: ['e2e/**/*.ts'],
    rules: { 'no-empty-pattern': 'off', '@typescript-eslint/unbound-method': 'off' },
  },
  { files: ['**/*.{js,mjs}', '*.config.ts'], ...tseslint.configs.disableTypeChecked },
  {
    // Node scripts: plain JavaScript, not part of the extension.
    files: ['tools/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly' },
    },
  },
);
