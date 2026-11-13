import { defineEnvVars } from '@sveltejs/kit/env';

/**
 * Environment variables used by the frontend.
 *
 * SvelteKit exposes these through `$app/env/public`; `import.meta.env` is not
 * populated for them (Vite only inlines `VITE_`-prefixed variables).
 */
export const variables = defineEnvVars({
  PUBLIC_API_BASE_URL: {
    public: true,
    description: 'Base URL the browser uses to reach the backend API.',
    schema: (value) => value || 'http://localhost:3000',
  },
});
