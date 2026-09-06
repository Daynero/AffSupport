#!/usr/bin/env node
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The Accounts tab (017) at every width, measured in a real browser.
 *
 * The agent row is a grid whose fixed tracks — the id, the status, the tasks
 * and the row's own buttons — are spent before the runs get a pixel, and a run
 * line is a flex row of things that do not shrink: the note, the day it was
 * written, a pencil, a bin and "+ Run". When the two do not fit, the note does
 * not overflow the page and nothing throws: `overflow-wrap: anywhere` folds it
 * into a column of single letters inside its cell, and `document.scrollWidth`
 * never moves. That is why the invariant checked here is not "the page does
 * not scroll sideways" but
 *
 *     every run line's scrollWidth === the width of the cell holding it
 *
 * and why it is checked at the widths either side of every breakpoint (560,
 * 1000, 1200) rather than at one comfortable desktop size. Add both sides of
 * any breakpoint you add: this list is what the next person will copy.
 *
 * It needs the beta stack up (`npm run beta:up`) and Playwright's Chromium.
 * Usage: node scripts/check-accounts-layout.mjs [teamId] [--site=http://…]
 * Exits non-zero and prints the offending widths when the invariant breaks.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import playwright from 'playwright-core';

const { chromium } = playwright;

const args = process.argv.slice(2);
const site =
  args.find(a => a.startsWith('--site='))?.slice('--site='.length) ?? 'http://127.0.0.1:5175';
const teamId = args.find(a => !a.startsWith('--')) ?? '22222222-2222-4222-8222-222222222222';

/** Either side of every breakpoint, plus the phones nobody remembers. */
const WIDTHS = [
  320, 360, 390, 414, 480, 560, 561, 700, 900, 1000, 1001, 1100, 1200, 1201, 1280, 1440, 1600
];

/**
 * The run each line is measured with, rather than whatever the beta happens to
 * hold: this is the shape the product itself offers as an example of a run
 * (`teamAgentNotePlaceholder`), and the 1001px failure this script first caught
 * depended on the note's length as much as on the day beside it. Seed the beta
 * with shorter notes and an unnormalised check would go quietly green.
 */
const SAMPLE_RUN = 'Pro Caps | TR 02/09';

/**
 * `playwright-core` ships no browsers, so it needs to be told where one is:
 * `PLAYWRIGHT_CHROME` first, then whatever `playwright` installed under the
 * user's cache, then Playwright's own resolver — which is the one that works
 * on a machine with the full package.
 */
function chromePath() {
  if (process.env.PLAYWRIGHT_CHROME) return process.env.PLAYWRIGHT_CHROME;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return null;
  const build = readdirSync(cache)
    .filter(name => name.startsWith('chromium-'))
    .sort()
    .pop();
  if (!build) return null;
  const app = join(
    cache,
    build,
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  );
  return existsSync(app) ? app : null;
}

const executablePath = chromePath();
const browser = await chromium.launch(
  executablePath ? { executablePath, headless: true } : { headless: true }
);
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

await page.goto(`${site}/login`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('theme', 'dark'));
const signIn = page.getByRole('button', { name: /beta-акаунт|beta account/i });
if (await signIn.count()) {
  await signIn.first().click();
  await page.waitForTimeout(3000);
}
await page.goto(`${site}/team/${teamId}/accounts`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.team-agent-row', { timeout: 15000 });

/**
 * Both halves of the worst case, written into the DOM and not into the beta's
 * data: a run written today prints no day, and the day is the widest thing on
 * the line after the note. Idempotent, so it can run at every width.
 */
const normalise = () =>
  page.evaluate(sample => {
    for (const line of document.querySelectorAll('.team-agent-run')) {
      if (line.classList.contains('is-empty')) continue;
      const text = line.querySelector('.team-agent-run-text');
      if (text) text.textContent = sample;
      if (line.querySelector('.team-agent-run-age')) continue;
      const stamp = document.createElement('time');
      stamp.className = 'team-agent-run-age';
      stamp.textContent = '5 днів тому';
      text?.after(stamp);
    }
  }, SAMPLE_RUN);

const failures = [];
for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(250);
  await normalise();
  const seen = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('.team-agent-run:not(.is-empty)')];
    return {
      rows: [...document.querySelectorAll('.team-agent-row')].map(row =>
        Math.round(row.getBoundingClientRect().height)
      ),
      spill: lines
        .map(line =>
          Math.round(line.scrollWidth - (line.parentElement?.getBoundingClientRect().width ?? 0))
        )
        .filter(over => over > 1),
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  const heights = [...new Set(seen.rows)];
  const uneven = width > 1000 && heights.length > 1;
  const ok = seen.spill.length === 0 && seen.page <= 0 && !uneven;
  if (!ok) failures.push({ width, ...seen });
  console.log(
    `${String(width).padStart(5)}  ${ok ? 'ok  ' : 'FAIL'}  rows ${heights.join('/')}` +
      (seen.spill.length ? `  spill ${seen.spill.join(',')}px` : '') +
      (seen.page > 0 ? `  page +${seen.page}px` : '')
  );
}

await browser.close();
if (failures.length > 0) {
  console.error(`\nRun lines overflow their cell at: ${failures.map(f => f.width).join(', ')}`);
  process.exit(1);
}
console.log('\nEvery run line fits its cell, and rows keep one height above 1000.');
