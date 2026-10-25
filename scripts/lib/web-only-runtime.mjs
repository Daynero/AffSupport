import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { outputDigest, readWebFile } from '../release-web-meta.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/** Static requests only; API, auth, pairing and SSE always reach their real producer. */
export async function candidateStaticResponse({ directory, url, origin, navigation = false }) {
  const request = new URL(url);
  if (request.origin !== origin || /^\/(?:api|pair|health)(?:\/|$)/u.test(request.pathname))
    return null;
  const relative = decodeURIComponent(request.pathname).replace(/^\//u, '');
  const file = navigation ? 'index.html' : relative;
  if (!file || file.split('/').some(part => part === '..' || part === '.' || !part))
    throw new Error('WEB_ONLY_STATIC_PATH_INVALID');
  const body = await readWebFile(directory, file, 16 * 1024 * 1024);
  /** @type {Record<string,string>} */
  const headers = {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store'
  };
  // Apply the candidate's global hosting headers in the beta browser too.
  const policy = await readFile(path.join(directory, '_headers'), 'utf8');
  let global = false;
  for (const line of policy.split(/\r?\n/u)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/u.test(line)) {
      global = line.trim() === '/*';
      continue;
    }
    if (global) {
      const match = /^\s+([A-Za-z-]+):\s*(.*)$/u.exec(line);
      if (match) headers[match[1].toLowerCase()] = match[2];
    }
  }
  return { status: 200, body, headers };
}

function executablePath() {
  if (process.env.PLAYWRIGHT_CHROME) return process.env.PLAYWRIGHT_CHROME;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  for (const build of readdirSync(cache)
    .filter(x => x.startsWith('chromium-'))
    .sort()
    .reverse()) {
    for (const suffix of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux/chrome',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    ]) {
      const candidate = path.join(cache, build, suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** @type {(cleanup: () => void) => void} */
const noShutdownObserver = () => {};

/** New source UI, unchanged package, real local Supabase fixture sign-in and visible completed job. */
export async function verifyCandidateWeb({
  directory,
  expectedDigest,
  origin,
  token,
  expectedFileName,
  timeoutMs = 90_000,
  onShutdownReady = noShutdownObserver
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('WEB_ONLY_BROWSER_DEADLINE');
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const site = new URL(origin);
  if (
    site.protocol !== 'http:' ||
    site.hostname !== '127.0.0.1' ||
    !['43140', '5175'].includes(site.port)
  )
    throw new Error('WEB_ONLY_BETA_ORIGIN_INVALID');
  if ((await outputDigest(directory)) !== expectedDigest)
    throw new Error('WEB_ONLY_BETA_BYTES_CHANGED');
  const server = await chromium.launchServer({
    host: '127.0.0.1',
    headless: true,
    timeout: remaining(),
    executablePath: executablePath(),
    args: ['--renderer-process-limit=1']
  });
  const owned = server.process();
  // Chromium has a private process group. Terminate that exact owned child
  // synchronously before a parent deadline can bypass asynchronous teardown.
  const terminateOwnedBrowser = () => {
    if (owned.pid && owned.exitCode === null && owned.signalCode === null) {
      try {
        process.kill(-owned.pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
    }
  };
  onShutdownReady(terminateOwnedBrowser);
  const timer = setTimeout(terminateOwnedBrowser, remaining());
  timer.unref();
  try {
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: remaining() });
    const context = await browser.newContext({ locale: 'en-GB', serviceWorkers: 'block' });
    let pageErrors = 0;
    let fulfilled = 0;
    let authRequests = 0;
    let authenticatedResponses = 0;
    context.on('response', response => {
      if (/\/auth\/v1\/token(?:\?|$)/u.test(response.url()) && response.ok())
        authenticatedResponses += 1;
    });
    await context.route('**/*', async route => {
      const request = route.request();
      if (/\/auth\/v1\/token(?:\?|$)/u.test(request.url())) authRequests += 1;
      const response = await candidateStaticResponse({
        directory,
        url: request.url(),
        origin,
        navigation: request.isNavigationRequest()
      });
      if (response) {
        fulfilled += 1;
        await route.fulfill(response);
      } else await route.continue();
    });
    context.setDefaultTimeout(Math.min(30_000, remaining()));
    context.setDefaultNavigationTimeout(Math.min(30_000, remaining()));
    const page = await context.newPage();
    page.on('pageerror', () => {
      pageErrors += 1;
    });
    await page.goto(`${origin}/login#agentToken=${token}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });
    const login = page.getByRole('button', { name: /Beta: space owner|Бета: власник простору/u });
    await login.waitFor({ timeout: 20_000 });
    await login.click();
    await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 30_000 });
    await page.goto(`${origin}/compressor#agentToken=${token}`, { waitUntil: 'domcontentloaded' });
    const row = page
      .locator('article.job-row[data-state="completed"]')
      .filter({ has: page.getByRole('heading', { name: expectedFileName, exact: true }) });
    await row.waitFor({ timeout: 30_000 });
    if (pageErrors || !fulfilled || !authRequests || !authenticatedResponses)
      throw new Error('WEB_ONLY_BROWSER_RESULT_UNPROVEN');
    if ((await outputDigest(directory)) !== expectedDigest)
      throw new Error('WEB_ONLY_BETA_BYTES_CHANGED');
    return { authenticated: true, visibleCompletedJob: true, exactStaticBytes: true };
  } finally {
    clearTimeout(timer);
    terminateOwnedBrowser();
    await server.kill();
    onShutdownReady(() => {});
  }
}
