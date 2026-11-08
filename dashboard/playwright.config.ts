import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5174',
    reducedMotion: 'reduce',
    colorScheme: 'dark',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'pnpm dev --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    env: { CHOKIDAR_USEPOLLING: '1' }
  }
});
