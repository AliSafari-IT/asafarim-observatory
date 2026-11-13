import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

// A visitor who is not signed in, on the deployed site. Nothing here submits credentials or changes data.
const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8'
);
const shot = (folder: string, name: string) => `uat-results/screenshots/${folder}/${name}.png`;
const path = (page: Page) => new URL(page.url()).pathname;
const SIGN_IN = 'Sign in with ASafariM';

for (const colorScheme of ['dark', 'light'] as const) {
  test(`UAT-01 a first-time visitor sees the public laptop workspace (${colorScheme})`, async ({
    browser,
    baseURL
  }) => {
    const context = await browser.newContext({
      colorScheme,
      viewport: { width: 1366, height: 900 }
    });
    const page = await context.newPage();
    const response = await page.goto('/');
    expect(path(page)).toBe('/');
    expect(response?.status()).toBe(200);
    expect(page.url().startsWith(baseURL!)).toBe(true);
    const notice = page.getByRole('region', { name: 'Your workspace access' });
    await expect(notice).toContainText('Public view');
    await expect(notice.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Generate summary', exact: true })).toBeDisabled();
    await page.screenshot({
      path: shot(`desktop-${colorScheme}`, '01-public-dashboard'),
      fullPage: true
    });
    await context.close();
  });
}

test('UAT-02 the sign-in page explains Observatory and offers one way in', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle('Your workspace, in perspective. · Observatory');
  await expect(page.locator('h1')).toHaveText(['Your workspace, in perspective.']);
  await expect(page.locator('main p').first()).toContainText('ASafariM account');
  await expect(page.locator('main p').first()).toContainText('viewer access');
  await expect(page.getByRole('link', { name: SIGN_IN })).toHaveCount(1);
  await expect(page.locator('.gateway-brand')).toHaveAttribute('href', '/');
  await expect(page.locator('.gateway-nav a')).toHaveText(['Dashboard', 'Access', 'Account']);
  await expect(page.locator('footer')).toContainText(/Gateway v\d+\.\d+\.\d+/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('UAT-03 sign in hands over to the ASafariM sign-in with a safe OpenID Connect request', async ({
  page,
  baseURL
}) => {
  await page.goto('/login');
  const authorize = page.waitForRequest((r) => new URL(r.url()).hostname === 'id.asafarim.site');
  await page.getByRole('link', { name: SIGN_IN }).click();
  const query = new URL((await authorize).url()).searchParams;
  await page.waitForLoadState('load');
  expect(new URL(page.url()).hostname).toBe('id.asafarim.site');
  expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(20);
  expect(query.get('redirect_uri')).toBe(`${baseURL}/auth/callback`);
  expect(query.get('response_type')).toBe('code');
  expect(query.get('code_challenge_method')).toBe('S256');
  expect(query.get('code_challenge')).toBeTruthy();
  expect(query.get('state')).toBeTruthy();
  expect(query.get('nonce')).toBeTruthy();
  expect((query.get('scope') ?? '').split(' ').sort()).toEqual([
    'email',
    'offline_access',
    'openid',
    'profile',
    'roles'
  ]);
  await page.screenshot({ path: shot('flows', '03-asafarim-sign-in'), fullPage: true });
});

test('UAT-04 deep links to private pages send a signed-out visitor to sign in', async ({
  page
}) => {
  for (const target of ['/access', '/account']) {
    await page.goto(target);
    expect(path(page), target).toBe('/login');
  }
  // A VPS link opens the public laptop workspace instead of VPS data.
  await page.goto('/?workspace=vps');
  expect(path(page)).toBe('/');
  await expect(page.getByRole('region', { name: 'Your workspace access' })).toContainText(
    'Public view'
  );
});

test('UAT-05 the theme toggle switches, announces its state and remembers it', async ({
  browser
}) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto('/login');
  const toggle = page.locator('[data-theme-toggle]').first();
  await expect(toggle).toHaveCount(1);
  expect((await toggle.getAttribute('aria-label'))?.trim()).toBeTruthy();
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = { bg: await background(), pressed: await toggle.getAttribute('aria-pressed') };
  await toggle.click();
  const after = await background();
  expect(after).not.toBe(before.bg);
  expect(await toggle.getAttribute('aria-pressed')).not.toBe(before.pressed);
  await page.screenshot({ path: shot('flows', '05-theme-toggled'), fullPage: true });
  await page.reload();
  expect(await background()).toBe(after);
  await context.close();
});

for (const [device, viewport] of [
  ['mobile', { width: 390, height: 844 }],
  ['tablet', { width: 820, height: 1180 }]
] as const) {
  for (const colorScheme of ['dark', 'light'] as const) {
    test(`UAT-06 the sign-in page works on a ${device} (${colorScheme})`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport,
        colorScheme,
        isMobile: device === 'mobile',
        hasTouch: true,
        deviceScaleFactor: 2
      });
      const page = await context.newPage();
      await page.goto('/login');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      const cta = await page.getByRole('link', { name: SIGN_IN }).boundingBox();
      expect(cta!.x).toBeGreaterThanOrEqual(0);
      expect(cta!.x + cta!.width).toBeLessThanOrEqual(viewport.width);
      const nav = await page.locator('.gateway-nav').boundingBox();
      expect(nav!.x + nav!.width).toBeLessThanOrEqual(viewport.width + 1);
      const heights = await page
        .locator('.gateway-nav a')
        .evaluateAll((links) => links.map((a) => a.getBoundingClientRect().height));
      for (const height of heights) expect(height).toBeGreaterThanOrEqual(24);
      await page.screenshot({ path: shot(device, `06-sign-in-${colorScheme}`), fullPage: true });
      await context.close();
    });
  }
}

test('UAT-07 a keyboard user can skip to the content and see where focus is', async ({ page }) => {
  await page.goto('/login');
  await page.keyboard.press('Tab');
  const active = () => page.evaluate(() => document.activeElement?.textContent?.trim());
  expect(await active()).toBe('Skip to content');
  expect(
    await page.evaluate(() => document.activeElement!.getBoundingClientRect().top)
  ).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: shot('flows', '07-skip-link-focused') });
  await page.keyboard.press('Enter');
  expect(new URL(page.url()).hash).toBe('#main');
  for (let i = 0; i < 12 && (await active()) !== SIGN_IN; i++) await page.keyboard.press('Tab');
  expect(await active()).toBe(SIGN_IN);
  const outline = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: shot('flows', '07-sign-in-focused') });
});

for (const colorScheme of ['dark', 'light'] as const) {
  test(`UAT-08 the sign-in page has no WCAG 2.1 AA problems axe can detect (${colorScheme})`, async ({
    browser
  }) => {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto('/login');
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => {
      // @ts-expect-error axe is the script added above
      const result = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }
      });
      return result.violations.map(
        (v: { id: string; impact: string; nodes: unknown[] }) =>
          `${v.id} (${v.impact}, ${v.nodes.length})`
      );
    });
    expect(violations).toEqual([]);
    await context.close();
  });
}

test('UAT-09 every link a signed-out visitor can see leads somewhere that works', async ({
  page,
  request
}) => {
  await page.goto('/login');
  const links = await page
    .locator('a[href]')
    .evaluateAll((all) =>
      all.map((a) => ({ text: a.textContent!.trim(), href: (a as HTMLAnchorElement).href }))
    );
  for (const link of links.filter((l) => !l.href.endsWith('#main'))) {
    const response = await request.get(link.href);
    expect(response.status(), `${link.text} → ${link.href}`).toBeLessThan(400);
  }
});

test('UAT-10 signed out, local data and health are public; VPS and actions are refused', async ({
  request
}) => {
  const health = await request.get('/healthz');
  expect(health.status()).toBe(200);
  const body = await health.json();
  expect(body.status).toBe('ok');
  expect(body.version).toMatch(/\d+\.\d+\.\d+/);
  expect(
    Object.keys(body).every((key) => ['status', 'version', 'gateway_version'].includes(key))
  ).toBe(true);
  for (const endpoint of ['/api/snapshot', '/api/analysis', '/api/summary']) {
    const response = await request.get(endpoint, { maxRedirects: 0 });
    expect(response.status(), endpoint).toBeLessThan(500);
    expect(response.status(), endpoint).not.toBe(401);
  }
  const context = await (await request.get('/auth/context')).json();
  expect(context.authenticated).toBe(false);
  expect(context.workspaces.map((w: { id: string }) => w.id)).toEqual(['local']);
  for (const endpoint of ['/api/snapshot?workspace=vps', '/api/summary?workspace=vps']) {
    const response = await request.get(endpoint, { maxRedirects: 0 });
    expect([400, 401], endpoint).toContain(response.status());
  }
  for (const endpoint of ['/api/refresh', '/api/summary']) {
    const response = await request.post(endpoint, { maxRedirects: 0, data: {} });
    expect([401, 403], endpoint).toContain(response.status());
  }
});

test.describe('UAT-11 security basics a visitor’s browser relies on', () => {
  test('transport and caching headers', async ({ request }) => {
    const headers = (await request.get('/login')).headers();
    expect(headers['strict-transport-security']).toMatch(/max-age=\d{7,}/);
    expect(headers['x-content-type-options']).toContain('nosniff');
    expect(headers['referrer-policy']).toBeTruthy();
    expect(headers['cache-control']).toContain('no-store');
  });

  test('a Content-Security-Policy that forbids framing', async ({ request }) => {
    const headers = (await request.get('/login')).headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp, 'Content-Security-Policy').not.toBe('');
    expect(
      /frame-ancestors/.test(csp) || !!headers['x-frame-options'],
      'frame-ancestors or X-Frame-Options'
    ).toBe(true);
  });

  test('another site cannot show the page in a frame', async ({ page, baseURL }) => {
    await page.setContent(`<iframe src="${baseURL}/login" width="800" height="600"></iframe>`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: shot('flows', '11-framing-test') });
    const framed = page.frames().find((frame) => frame.url().startsWith(baseURL!));
    expect(
      framed ? await framed.locator('h1').count() : 0,
      'the page rendered in a third-party frame'
    ).toBe(0);
  });

  test('HEAD /login is answered like GET', async ({ request }) => {
    expect((await request.head('/login')).status()).toBe(200);
  });

  test('cross-site form posts and unsupported methods are refused', async ({ request }) => {
    const post = await request.post('/access/continue', {
      headers: { origin: 'https://evil.example' },
      form: { csrf: 'x' },
      maxRedirects: 0
    });
    expect(post.status()).toBe(403);
    expect((await request.fetch('/login', { method: 'PUT' })).status()).toBe(405);
  });
});

test('UAT-12 the sign-in page loads quickly and stays light', async ({ page }) => {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    await page.goto('/login', { waitUntil: 'load' });
    samples.push(
      await page.evaluate(() =>
        Math.round(
          (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)
            .loadEventEnd
        )
      )
    );
  }
  expect(samples.sort((a, b) => a - b)[1]).toBeLessThan(2000);
  const bytes = await page.evaluate(
    () =>
      performance
        .getEntriesByType('resource')
        .reduce((sum, e) => sum + ((e as PerformanceResourceTiming).transferSize || 0), 0) +
      ((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)
        .transferSize || 0)
  );
  expect(bytes).toBeLessThan(200_000);
});
