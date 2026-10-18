import { defineConfig } from '@playwright/test'

// Two suites, same UI:
//   mock  every beat against the in-browser simulated factory. No backend; safe for CI.
//   real  the contract test: the same beats against a running `factory serve` in Dev mode
//         (free, no API key). Run serially; it shares the server's line, log and production.
const PORT = Number(process.env.E2E_PORT ?? 5180)

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'mock', testMatch: /mock\/.*\.spec\.ts/, fullyParallel: true },
    { name: 'real', testMatch: /real\/.*\.spec\.ts/ },
  ],
})
