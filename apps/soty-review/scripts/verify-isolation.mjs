import { chromium } from 'playwright-core';

const surfaceIds = [
  'auth-entry',
  'global-shell',
  'home-tools',
  'compressor',
  'landing-optimizer',
  'landing-gallery',
  'transcription',
  'team-lobby',
  'team-create-space',
  'team-workspace',
  'team-settings',
  'account-profile',
  'component-showcase'
];
const stateIds = [
  'default',
  'loading',
  'empty',
  'success',
  'error',
  'active',
  'confirmation',
  'disabled'
];

export async function verifyIsolation(baseUrl, executablePath) {
  const browser = await chromium.launch({ headless: true, executablePath });
  let interactions = 0;
  const violations = [];
  try {
    const context = await browser.newContext();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(baseUrl).origin) {
        violations.push(url.href);
        await route.abort();
      } else await route.continue();
    });
    const page = await context.newPage();
    for (const surfaceId of surfaceIds) {
      for (const stateId of stateIds) {
        await page.goto(`${baseUrl}/#/screen/${surfaceId}?state=${stateId}&theme=light&locale=uk`, {
          waitUntil: 'networkidle'
        });
        const actions = page.locator('[data-demo-action]');
        const count = await actions.count();
        if (count > 0) {
          await actions.first().click({ force: true });
          interactions++;
        }
      }
    }
    if (interactions < 50)
      throw new Error(`Expected at least 50 demo actions, observed ${interactions}.`);
    if (violations.length) throw new Error(`Forbidden requests: ${violations.join(', ')}`);
    await context.close();
    return { interactions, violations: 0 };
  } finally {
    await browser.close();
  }
}
