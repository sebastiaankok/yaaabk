import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // In development the SPA is served by Vite on :5173 while the API listens on
  // the project's port. Proxy `/api` so the page's relative fetches reach it.
  server: {
    proxy: {
      '/api': 'http://localhost:{{port}}',
    },
  },
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode, except for libraries. Can be removed in Svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },
      // Single-page app: the Bun server serves `web/build` and falls back to
      // `index.html` for client-side routes.
      adapter: adapter({ fallback: 'index.html' }),
    }),
  ],
});
