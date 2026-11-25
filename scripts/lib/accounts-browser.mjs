/** Shared real-browser bootstrap for the local beta acceptance scripts. */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import playwright from 'playwright-core';

export function chromePath() {
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
/**
 * A real browser on a page of a local site — the beta (`npm run dev:beta`, port 5175, signed in
 * with the beta owner's button) or a development server answering from memory
 * (`VITE_MOCK_DATA=true VITE_LOCAL_DEV_AUTH=true`, no sign-in at all). Restricted to loopback:
 * these checks read layout, and a layout read against a real account is not theirs to make.
 *
 * `path(teamId)` is the page to open once signed in; `ready` is a selector that is on screen
 * when the page has its content.
 *
 * @param {string[]} args
 * @param {{
 *   defaultTeam: string,
 *   path: (teamId: string) => string,
 *   ready: string,
 *   viewport?: { width: number, height: number }
 * }} options
 */
export async function openLocalBrowser(args, { defaultTeam, path, ready, viewport }) {
  const site = args.find(arg => arg.startsWith('--site='))?.slice(7) ?? 'http://127.0.0.1:5175';
  const url = new URL(site);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('These checks are restricted to a local beta site.');
  }
  const teamId = args.find(arg => !arg.startsWith('--')) ?? defaultTeam;
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) throw new Error('A beta team UUID is required.');
  const storageState = args.find(arg => arg.startsWith('--storage-state='))?.slice(16);
  const colorScheme = args.find(arg => arg.startsWith('--theme='))?.slice(8);
  const browser = await playwright.chromium.launch({
    executablePath: chromePath(),
    headless: true
  });
  try {
    const context = await browser.newContext({
      viewport: viewport ?? { width: 1600, height: 900 },
      ...(colorScheme === 'light' || colorScheme === 'dark' ? { colorScheme } : {}),
      ...(storageState ? { storageState } : {})
    });
    // The product keeps its own choice of theme; `--theme` makes it the one asked for.
    if (colorScheme === 'light' || colorScheme === 'dark') {
      await context.addInitScript(theme => localStorage.setItem('theme', theme), colorScheme);
    }
    const page = await context.newPage();
    await page.goto(`${site}/login`, { waitUntil: 'domcontentloaded' });
    const signIn = page.getByRole('button', {
      name: /beta-акаунт|beta account|Бета: власник простору|Beta: space owner/i
    });
    if (await signIn.count()) {
      await signIn.first().click();
      await page.waitForURL(url => !url.pathname.includes('login'), { timeout: 15000 });
    }
    await page.goto(`${site}${path(teamId)}`, { waitUntil: 'domcontentloaded' });
    await page.locator(ready).first().waitFor({ timeout: 15000 });
    return { browser, context, page, site, teamId };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function openAccountsBrowser(args = process.argv.slice(2)) {
  return openLocalBrowser(args, {
    defaultTeam: '22222222-2222-4222-8222-222222222222',
    path: teamId => `/team/${teamId}/accounts`,
    ready: '.team-account-space.is-unified .team-agent-row'
  });
}
