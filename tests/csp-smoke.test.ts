import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { describeRequiring, allOf, requirePath } from './support/requires.js';

/**
 * The content policy, in a browser that actually enforces it.
 *
 * Everything else about this policy is checked by reading strings, and reading
 * strings cannot tell you that the page still works. A policy mistake is
 * invisible to unit tests and total in production: the page loads, the browser
 * refuses one thing it needed, and the application is broken for everyone at
 * once. That failure mode is the entire reason the contract calls this test
 * mandatory rather than nice to have.
 *
 * The headers are served here the way the host serves them — parsed out of the
 * committed `_headers` file rather than restated — so this exercises the policy
 * that ships, not a copy of it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'apps/web/dist');

/** The `/*` block from the deployed headers file. */
async function deployedHeaders(): Promise<Record<string, string>> {
  const source = await readFile(path.join(root, 'apps/web/public/_headers'), 'utf8');
  const block = source.split(/^\/\*$/mu)[1] ?? '';
  const headers: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^\s{2}([A-Za-z-]+):\s*(.+)$/u.exec(line);
    if (match) headers[match[1]] = match[2];
    if (/^\S/u.test(line) && line.trim()) break;
  }
  return headers;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

/** Serves the built site with the real headers attached. */
async function serveDist(headers: Record<string, string>) {
  const server = createServer(async (request, response) => {
    const requested = (request.url ?? '/').split('?')[0];
    const candidate = path.join(DIST, requested === '/' ? 'index.html' : requested);
    const file =
      existsSync(candidate) && !candidate.endsWith('/') ? candidate : path.join(DIST, 'index.html');
    try {
      const body = await readFile(file);
      for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
      response.setHeader(
        'Content-Type',
        CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream'
      );
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(r => server.close(() => r()))
  };
}

let browser: Browser | null = null;

afterAll(async () => {
  await browser?.close();
  browser = null;
});

describeRequiring(
  allOf(requirePath('apps/web/dist/index.html'), requirePath('apps/web/public/_headers')),
  'the content policy in a real browser',
  () => {
    it('loads the application without a single policy violation', async () => {
      const headers = await deployedHeaders();
      expect(headers['Content-Security-Policy']).toBeTruthy();

      const site = await serveDist(headers);
      browser ??= await chromium.launch({ headless: true });
      const page = await browser.newPage();

      // Everything the browser refused, in its own words. Collected rather than
      // sampled: one blocked script is the difference between a working page
      // and a blank one.
      const violations: string[] = [];
      page.on('console', message => {
        const text = message.text();
        if (/Content Security Policy|Refused to/iu.test(text)) violations.push(text);
      });
      page.on('pageerror', error => violations.push(`pageerror: ${error.message}`));

      await page.goto(site.origin, { waitUntil: 'networkidle' });

      // The inline theme bootstrap runs before hydration; if its hash were
      // wrong the browser would refuse it and this attribute would be missing —
      // which is the cheapest possible proof that the hashes are right.
      const theme = await page.getAttribute('html', 'data-theme');
      expect(theme === 'light' || theme === 'dark').toBe(true);

      // The application mounted: the policy did not block the module bundle.
      await page.waitForSelector('#root *', { timeout: 15_000 });

      await page.close();
      await site.close();
      expect(violations).toEqual([]);
    }, 120_000);

    it('refuses an injected inline script', async () => {
      const headers = await deployedHeaders();
      const site = await serveDist(headers);
      browser ??= await chromium.launch({ headless: true });
      const page = await browser.newPage();

      const refusals: string[] = [];
      page.on('console', message => {
        if (/Refused to execute|Content Security Policy/iu.test(message.text())) {
          refusals.push(message.text());
        }
      });

      await page.goto(site.origin, { waitUntil: 'domcontentloaded' });
      // The attack this policy exists to stop: script on the origin that stores
      // the local app's session token.
      await page.evaluate(() => {
        const injected = document.createElement('script');
        injected.textContent = 'window.__injected = true;';
        document.head.appendChild(injected);
      });
      await page.waitForTimeout(200);

      expect(await page.evaluate(() => '__injected' in window)).toBe(false);
      expect(refusals.length).toBeGreaterThan(0);

      await page.close();
      await site.close();
    }, 120_000);
  }
);
