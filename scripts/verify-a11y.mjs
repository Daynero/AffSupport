#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

/**
 * Walks the built interface with an accessibility engine, in both themes.
 *
 * Everything else in this repository checks accessibility by reading source:
 * that a role is present, that a selector covers an element. None of it can tell
 * you the contrast of text against the background it actually lands on, or that
 * a label points at an element that exists in the rendered tree. This runs the
 * real page.
 *
 * **Blocking, against an empty baseline.** The plan expected a report-only
 * phase with a list of existing violations to work down; the sweep found two,
 * both the same insufficient contrast on a link in dark mode, and fixing them
 * took one colour. A baseline mechanism is kept because the day a violation
 * arrives that cannot be fixed immediately, recording it beats switching the
 * gate off — but it is empty, and an empty baseline means any violation fails.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'apps/web/dist');
const BASELINE = path.join(root, 'a11y-baseline.json');
const AXE = path.join(root, 'node_modules/axe-core/axe.min.js');

/** The routes a signed-out visitor can reach without a local app. */
const ROUTES = ['/', '/login', '/privacy', '/terms'];
const THEMES = ['light', 'dark'];

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

async function serve() {
  const server = createServer(async (request, response) => {
    const requested = (request.url ?? '/').split('?')[0];
    const candidate = path.join(DIST, requested === '/' ? 'index.html' : requested.slice(1));
    const file =
      existsSync(candidate) && path.extname(candidate) ? candidate : path.join(DIST, 'index.html');
    try {
      const body = await readFile(file);
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
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(() => resolve(undefined)))
  };
}

if (!existsSync(DIST)) {
  process.stderr.write('a11y: apps/web/dist is missing. Build the web app first.\n');
  process.exit(1);
}

const site = await serve();
const browser = await chromium.launch({ headless: true });
const axeSource = readFileSync(AXE, 'utf8');
const found = [];

for (const theme of THEMES) {
  for (const route of ROUTES) {
    const page = await browser.newPage();
    // The theme is stored, not guessed, so the page renders the one being swept
    // rather than whatever the headless default happens to be.
    await page.addInitScript(`localStorage.setItem('theme', ${JSON.stringify(theme)})`);
    await page.goto(`${site.origin}${route}`, { waitUntil: 'networkidle' });
    await page.addScriptTag({ content: axeSource });
    const result = await page.evaluate(async () => {
      // Runs inside the page, where `window` and `document` exist; the script
      // type-checks in a Node context that has neither.
      const runner = /** @type {{ axe: { run: Function } }} */ (/** @type {unknown} */ (globalThis))
        .axe;
      return runner.run(globalThis.document, {
        resultTypes: ['violations'],
        // Best-practice rules are opinions; these are the ones with a standard
        // behind them.
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }
      });
    });
    for (const violation of result.violations) {
      found.push({
        id: violation.id,
        impact: violation.impact,
        route,
        theme,
        nodes: violation.nodes.length
      });
    }
    await page.close();
  }
}

await browser.close();
await site.close();

const key = entry => `${entry.id}|${entry.route}|${entry.theme}`;
const counts = {};
for (const entry of found) counts[key(entry)] = (counts[key(entry)] ?? 0) + entry.nodes;

if (process.argv.includes('--update-baseline')) {
  await writeFile(
    BASELINE,
    `${JSON.stringify(
      {
        note: 'Accessibility violations present when the sweep was introduced. New violations fail the gate; these are worked down deliberately. Refresh with: node scripts/verify-a11y.mjs --update-baseline',
        counts
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(`a11y: baseline written with ${Object.keys(counts).length} entries.\n`);
  process.exit(0);
}

const baseline = existsSync(BASELINE)
  ? (JSON.parse(readFileSync(BASELINE, 'utf8')).counts ?? {})
  : {};
const regressions = Object.entries(counts).filter(([name, count]) => count > (baseline[name] ?? 0));
const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

process.stdout.write(
  `a11y: ${ROUTES.length} routes x ${THEMES.length} themes, ${total} violation node(s), ` +
    `${regressions.length} above baseline\n`
);
for (const [name, count] of regressions) {
  process.stdout.write(`  ${name}: ${count} (baseline ${baseline[name] ?? 0})\n`);
}
if (regressions.length) process.exit(1);
