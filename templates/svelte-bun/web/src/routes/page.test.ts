import { render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import Page from './+page.svelte';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('shows the greeting the API returns', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(JSON.stringify({ message: 'Hello from tests' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );

  render(Page);

  expect(screen.getByTestId('app-title')).toHaveTextContent('{{projectName}}');
  await waitFor(() => {
    expect(screen.getByTestId('greeting')).toHaveTextContent('Hello from tests');
  });
});
