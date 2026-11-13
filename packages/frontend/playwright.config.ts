import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'src',
  testMatch: '**/*.e2e.{ts,js}',
  use: { baseURL: 'http://localhost:5173' },
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
