import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      '**/.output/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'templates/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  svelte.configs.recommended,
  svelte.configs.prettier,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    // Vendored shadcn-svelte primitives are generic: link callers resolve their
    // own hrefs, so the primitive itself cannot know about SvelteKit routes.
    files: ['packages/frontend/src/lib/components/ui/**/*.svelte'],
    rules: { 'svelte/no-navigation-without-resolve': 'off' },
  },
);
