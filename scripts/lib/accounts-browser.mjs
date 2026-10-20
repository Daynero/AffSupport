/** Shared real-browser bootstrap for the local beta acceptance scripts. */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import playwright from 'playwright-core';

function chromePath() {
  if (process.env.PLAYWRIGHT_CHROME) return process.env.PLAYWRIGHT_CHROME;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter(name => name.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const build of builds) {
    for (const suffix of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux/chrome',
      'chrome-win/chrome.exe'
    ]) {
      const candidate = join(cache, build, suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
export async function openAccountsBrowser(args = process.argv.slice(2)) {
  const site = args.find(arg => arg.startsWith('--site='))?.slice(7) ?? 'http://127.0.0.1:5175';
  const url = new URL(site);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('These checks are restricted to a local beta site.');
  }
  const teamId = args.find(arg => !arg.startsWith('--')) ?? '22222222-2222-4222-8222-222222222222';
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) throw new Error('A beta team UUID is required.');
  const storageState = args.find(arg => arg.startsWith('--storage-state='))?.slice(16);
  const browser = await playwright.chromium.launch({
    executablePath: chromePath(),
    headless: true
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      ...(storageState ? { storageState } : {})
    });
    const page = await context.newPage();
    await page.goto(`${site}/login`, { waitUntil: 'domcontentloaded' });
    const signIn = page.getByRole('button', { name: /beta-акаунт|beta account/i });
    if (await signIn.count()) {
      await signIn.first().click();
      await page.waitForURL(url => !url.pathname.includes('login'), { timeout: 15000 });
    }
    await page.goto(`${site}/team/${teamId}/accounts`, { waitUntil: 'domcontentloaded' });
    await page
      .locator('.team-account-space.is-unified .team-agent-row')
      .first()
      .waitFor({ timeout: 15000 });
    return { browser, context, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
