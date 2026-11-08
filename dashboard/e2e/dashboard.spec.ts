import { expect, test, type Page } from '@playwright/test';

async function fixtures(page: Page, role = 'admin') {
  const calls: string[] = [];
  await page.route('**/auth/context', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        role,
        canReview: role === 'admin',
        onboarded: true,
        csrf: 'fixture-csrf',
        workspaces: [
          { id: 'local', label: 'Laptop workspace' },
          { id: 'vps', label: 'VPS workspace' }
        ]
      }
    })
  );
  await page.route('**/healthz', (route) =>
    route.fulfill({ json: { status: 'ok', version: '0.2.2' } })
  );
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const workspace = url.searchParams.get('workspace') ?? 'local';
    const count = workspace === 'vps' ? 3 : 18;
    const root = workspace === 'vps' ? '/var/repos' : '/example/repos';
    const repositories = Array.from({ length: count }, (_, index) => ({
      name: `${workspace}-repo-${index + 1}`,
      path: `${root}/repo-${index + 1}`,
      branch: 'main',
      detached: false,
      changed_files: 0
    }));
    if (route.request().method() === 'POST') calls.push(`${url.pathname}:${workspace}`);
    if (url.pathname === '/api/snapshot')
      return route.fulfill({
        json: { schema_version: 1, root, scanned_at: '2026-11-08T16:00:00Z', repositories }
      });
    if (url.pathname === '/api/analysis')
      return route.fulfill({
        json: {
          schema_version: 1,
          root,
          snapshot_count: 2,
          period_start: '2026-11-08T15:00:00Z',
          period_end: '2026-11-08T16:00:00Z',
          sources: ['snapshot-fixture.json'],
          repositories: repositories.map((repository) => ({
            ...repository,
            status: 'clean',
            observations: 2,
            failed_observations: 0,
            observed_branch_switches: 0,
            observed_count_changes: 0,
            peak_changed_files: 0,
            latest_changed_files: 0
          }))
        }
      });
    return route.fulfill({ json: { configured: true, summary: null } });
  });
  return calls;
}

test('section selection follows clicks, back navigation and manual scrolling', async ({ page }) => {
  await fixtures(page);
  await page.goto('/');
  await expect(page.getByText('local-repo-18', { exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Dashboard navigation' });
  const repos = nav.getByRole('link', { name: /Repositories/ });
  const overview = nav.getByRole('link', { name: /Overview/ });
  const history = nav.getByRole('link', { name: /Saved history/ });
  await repos.click();
  await expect(repos).toHaveAttribute('aria-current', 'location');
  await expect(overview).not.toHaveAttribute('aria-current');
  await history.click();
  await expect(history).toHaveAttribute('aria-current', 'location');
  await page.goBack();
  await expect(repos).toHaveAttribute('aria-current', 'location');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(overview).toHaveAttribute('aria-current', 'location');
});

test('shared theme toggle persists light mode and the access notice is distinct', async ({
  page
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fixtures(page);
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Dark theme', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const notice = page.getByRole('region', { name: 'Your workspace access' });
  await expect(notice).toBeVisible();
  expect(await notice.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    await page
      .locator('.stat')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor)
  );
  await page.screenshot({ path: info.outputPath('dashboard-light.png'), fullPage: false });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: info.outputPath('dashboard-dark.png'), fullPage: false });
  expect(errors).toEqual([]);
});

test('workspace selection isolates displayed data, survives reload and targets generation', async ({
  page
}) => {
  const calls = await fixtures(page);
  await page.goto('/');
  await expect(page.getByText('local-repo-18', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('vps');
  await expect(page.getByText('vps-repo-3', { exact: true })).toBeVisible();
  await expect(page.getByText('local-repo-18', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/workspace=vps/);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue('vps');
  await expect(page.getByText('vps-repo-3', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Generate summary', exact: true }).click();
  await expect.poll(() => calls.includes('/api/summary:vps')).toBe(true);
  expect(calls.includes('/api/summary:local')).toBe(false);
});

test('viewers can change workspace and read data while admin actions stay disabled', async ({
  page
}) => {
  const calls = await fixtures(page, 'viewer');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?workspace=vps#repositories');
  await expect(page.getByText('vps-repo-3', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate summary', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reload saved data', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  expect(calls).toEqual([]);
});

test('review approval needs no reason and rejection retains native validation', async ({
  page
}) => {
  const { accessPage } = await import('../../gateway/access-pages.mjs');
  await page.setContent(
    accessPage({ role: 'admin', canReview: true, onboarded: true }, 'csrf-fixture', [
      {
        id: 'fixture-request',
        email: 'fixture@example.test',
        status: 'pending',
        reason: 'Testing review forms.',
        created_at: 0
      }
    ])
  );
  const approve = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Approve admin', exact: true }) });
  const decline = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Decline and email reason', exact: true }) });
  expect(await approve.evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(true);
  expect(await decline.evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(false);
  await decline.locator('textarea').fill('Admin tools are restricted to workspace maintainers.');
  expect(await decline.evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(true);
});

test('gateway access pages share navigation, footer and persisted themes at mobile width', async ({
  page
}) => {
  const { page: render, themeAsset } = await import('../../gateway/page.mjs');
  const html = render(
    'Your Observatory access',
    '<p>Your role: viewer.</p><form><label>Reason<textarea required></textarea></label><button>Submit</button></form>'
  );
  await page.route('**/asafarim-theme/*', (route) => {
    const asset = themeAsset(new URL(route.request().url()).pathname);
    return route.fulfill({ body: asset.body, contentType: asset.type });
  });
  await page.route('http://127.0.0.1:5174/access', (route) =>
    route.fulfill({ body: html, contentType: 'text/html' })
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/access');
  await expect(
    page
      .getByRole('navigation', { name: 'Observatory navigation' })
      .getByRole('link', { name: 'Access', exact: true })
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page
      .getByRole('navigation', { name: 'Footer navigation' })
      .getByRole('link', { name: 'Privacy' })
  ).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Dark theme', exact: true });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(render('<script>fixture</script>', '')).not.toContain('<title><script>');
});
