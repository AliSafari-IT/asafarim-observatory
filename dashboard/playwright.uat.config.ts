import { defineConfig, devices } from '@playwright/test';

// End-user acceptance tests against a deployed Observatory (default: production), signed out only.
// Run on demand with `pnpm test:uat`; never in CI, which must not depend on production.
// UAT_BASE targets another deployment. Screenshots and results go to uat-results/ (git-ignored).
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;

export default defineConfig({
  testDir: './uat',
  testMatch: '**/*.uat.ts',
  outputDir: './uat-results/artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: 'uat-results/results.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.UAT_BASE ?? 'https://observatory.asafarim.site',
    viewport: { width: 1366, height: 900 },
    // UAT_CHROMIUM: a Chromium build to use when Playwright's own isn't installed.
    ...(process.env.UAT_CHROMIUM
      ? { launchOptions: { executablePath: process.env.UAT_CHROMIUM } }
      : {}),
    ...(proxy ? { proxy } : {})
  }
});
