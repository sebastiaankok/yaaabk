import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';

// Read `.env` from the repository root so a single file configures every package.
const envDir = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  envDir,
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },
      adapter: adapter(),
      // SvelteKit reads `$app/env` variables from its own `env.dir` (defaults to
      // the package root), so point it at the same root `.env` as Vite.
      env: { dir: envDir },
    }),
  ],
  test: {
    expect: { requireAssertions: true },
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.{test,spec}.{js,ts}'],
          exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
        },
      },
    ],
  },
});
