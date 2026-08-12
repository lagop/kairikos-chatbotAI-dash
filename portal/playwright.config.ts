import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // WP-02 — scoped to tests/specs/ only. The default './tests' also
  // matches tests/unit/*.test.ts (Vitest specs — Playwright's default
  // testMatch picks up *.test.ts too), which errors trying to import
  // `vitest` in Playwright's runtime.
  testDir: './tests/specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { outputFolder: 'playwright-report' }], ['list']],
  use: {
    baseURL: process.env.PORTAL_URL || 'https://portal.kairikos.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 13'] },
    },
  ],
  webServer: process.env.CI
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:3001',
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
      },
});