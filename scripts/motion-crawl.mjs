#!/usr/bin/env node
/**
 * Walks a screen of the beta and films every control that changes what is
 * shown (058): tabs, filters, toggles, menus, things that expand. For each it
 * prints how the picture changed, frame by frame:
 *
 *   ok     one change, spread over many frames (or none worth the name)
 *   CUT    most of a change landed in a single frame
 *   TWICE  the screen changed, paused, and changed again
 *   BLINK  something appeared and was gone again within the recording
 *
 *   node scripts/motion-crawl.mjs --routes /team/<id>/accounts,/account [--out <dir>]
 *
 * Only controls that say they hold state are pressed (`aria-pressed`,
 * `aria-expanded`, `aria-haspopup`, a tab, a switch, a quick filter); a plain
 * button — an action — never is, and anything whose words name a write is
 * skipped. A switch is pressed twice, so it ends where it began. Frames of the
 * flagged steps are kept as PNGs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { chromeExecutable, signIn, supabaseEnv } from './motion-smoke.mjs';
import { distance, lumaOf } from './lib/motion-metric.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, /** @type {Array<[string, string]>} */ ([]))
);
const base = args.base ?? 'http://127.0.0.1:5175';
const out = args.out ?? path.join(process.cwd(), 'motion-crawl');
const routes = (args.routes ?? '/').split(',');
const perRoute = Number(args.max ?? 40);
const VIEWPORT = { width: Number(args.width ?? 1280), height: 800 };
const FILM_MS = Number(args.ms ?? 1300);

const CANDIDATES = [
  '[role="tab"]',
  'a.ui-tab',
  '[aria-pressed]',
  '[aria-expanded]',
  '[aria-haspopup]',
  '[role="switch"]',
  'summary',
  '.task-quick-range',
  '.toggle-button',
  '.ui-accordion-trigger',
  'select'
].join(', ');

/** Never pressed: they write, or they are one of many identical row controls. */
const SKIP_CLASS =
  /team-task-status-option|team-task-card-select|team-explorer-check|row-check|danger|team-space-tabs/u;
const SKIP_WORDS =
  /видал|delete|архів|archive|вийти|sign out|leave|покинути|перепідключ|reconnect|синхроніз|sync now|згенер|generate|зберегти|save|надіслат|send|оплат|pay|скасувати|cancel|запросити|invite|передати|transfer|стиснути|compress|завантаж|upload|download/iu;

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await signIn(page, base, supabaseEnv(), args.email ?? 'beta@soty.local');

/** @param {() => Promise<void>} act */
async function film(act) {
  /** @type {Array<{ wall: number, buffer: Buffer }>} */
  const frames = [];
  const onFrame = (/** @type {any} */ { data, metadata, sessionId }) => {
    frames.push({ wall: metadata.timestamp * 1000, buffer: Buffer.from(data, 'base64') });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', {
    format: 'png',
    everyNthFrame: 1,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height
  });
  await page.waitForTimeout(200);
  const t0 = Date.now();
  await act();
  await page.waitForTimeout(FILM_MS);
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);

  const rect = { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };
  /** @type {Float32Array | null} */
  let previous = null;
  /** @type {Float32Array | null} */
  let first = null;
  const rows = frames.map((frame, index) => {
    const png = PNG.sync.read(frame.buffer);
    const luma = lumaOf(png.data, png.width, rect, 4);
    const step = previous ? distance(previous, luma) : 0;
    first ??= luma;
    previous = luma;
    return { index, at: Math.round(frame.wall - t0), step, luma, buffer: frame.buffer };
  });
  /** @type {Array<{ from: number, to: number, sum: number, peak: number, peakIndex: number, frames: number }>} */
  const bursts = [];
  for (const row of rows) {
    if (row.at < 0 || row.step <= 0.25) continue;
    const last = bursts.at(-1);
    if (last && row.at - last.to <= 90) {
      last.to = row.at;
      last.sum += row.step;
      if (row.step > last.peak) {
        last.peak = row.step;
        last.peakIndex = row.index;
      }
      last.frames += 1;
    } else
      bursts.push({
        from: row.at,
        to: row.at,
        sum: row.step,
        peak: row.step,
        peakIndex: row.index,
        frames: 1
      });
  }
  const real = bursts.filter(burst => burst.sum > 1.2);
  // One frame carrying nearly all of a change that is worth the name. A short fade (a menu's
  // five frames) records as two or three; a focus ring after Escape is under the bar.
  const cuts = real.filter(
    burst => burst.sum > 1.7 && burst.peak / burst.sum > 0.8 && burst.frames <= 2
  );
  // Back where it started after having been somewhere else: a blink.
  const last = rows.at(-1);
  const travelled = real.reduce((sum, burst) => sum + burst.sum, 0);
  const net = first && last ? distance(first, last.luma) : 0;
  const blink = real.length > 1 && travelled > 2.5 && net < travelled * 0.2;
  const verdict = blink ? 'BLINK' : cuts.length ? 'CUT' : real.length > 1 ? 'TWICE' : 'ok';
  return { verdict, real, rows, cuts };
}

/** @param {string} label @param {Awaited<ReturnType<typeof film>>} result @param {string} dir */
function report(label, result, dir) {
  const { verdict, real, rows, cuts } = result;
  const shape = real
    .map(
      burst =>
        `${burst.from}–${burst.to}ms Σ${burst.sum.toFixed(1)} peak ${burst.peak.toFixed(1)} (${burst.frames}f)`
    )
    .join(' | ');
  console.log(`${verdict.padEnd(5)} ${label} — ${shape || 'no change'}`);
  if (verdict === 'ok') return;
  mkdirSync(dir, { recursive: true });
  const keep = new Set();
  for (const burst of cuts.length ? cuts : real) {
    for (const index of [burst.peakIndex - 1, burst.peakIndex, burst.peakIndex + 1])
      keep.add(index);
  }
  for (const row of rows) {
    if (keep.has(row.index))
      writeFileSync(
        path.join(dir, `${String(row.index).padStart(3, '0')}_${row.at}ms.png`),
        row.buffer
      );
  }
}

let flagged = 0;
for (const route of routes) {
  await page.goto(`${base}${route}`);
  await page.waitForTimeout(3500);
  console.log(`\n== ${route}`);
  const found = await page.evaluate(
    ({ selector }) => {
      const seen = new Map();
      const list = [];
      let id = 0;
      for (const node of document.querySelectorAll(selector)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
        // Section tabs leave the screen being walked; each section is a route of its own here.
        if (node.closest('.team-space-tabs')) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        if (/** @type {HTMLButtonElement} */ (node).disabled) continue;
        const text = (
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          node.getAttribute('data-tip') ||
          node.textContent ||
          ''
        )
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, 48);
        const cls = typeof node.className === 'string' ? node.className : '';
        // The same control repeated down a list is filmed twice, not forty times.
        const kind = `${node.tagName}.${cls.split(' ').slice(0, 2).join('.')}`;
        const count = seen.get(kind) ?? 0;
        if (count >= 2) continue;
        seen.set(kind, count + 1);
        id += 1;
        node.setAttribute('data-crawl', String(id));
        list.push({
          id,
          text,
          cls,
          tag: node.tagName.toLowerCase(),
          twice: node.getAttribute('role') === 'switch' || node.hasAttribute('aria-pressed'),
          inTopbar: Boolean(node.closest('header.topbar'))
        });
      }
      return list;
    },
    { selector: CANDIDATES }
  );
  const targets = found
    .filter(item => !SKIP_CLASS.test(item.cls) && !SKIP_WORDS.test(item.text))
    .filter(item => (args.topbar ? true : !item.inTopbar))
    .slice(0, perRoute);
  for (const item of targets) {
    const locator = page.locator(`[data-crawl="${item.id}"]`).first();
    if (!(await locator.count())) continue;
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 1500 });
    } catch {
      continue;
    }
    await page.waitForTimeout(250);
    const box = await locator.boundingBox();
    if (!box) continue;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const slug = `${route.replace(/[^a-z0-9]+/giu, '-')}_${item.id}`;
    const label = `${item.tag}${item.cls ? `.${item.cls.split(' ')[0]}` : ''} "${item.text}"`;
    const before = page.url();
    const press = await film(async () => {
      if (item.tag === 'select') {
        // A native list cannot be filmed; move one option along instead.
        await locator.evaluate(node => {
          const select = /** @type {HTMLSelectElement} */ (node);
          select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
      } else await page.mouse.click(x, y);
    });
    report(`press   ${label}`, press, path.join(out, `${slug}_press`));
    if (press.verdict !== 'ok') flagged += 1;
    // Put things back: a second press for a toggle, Escape for whatever opened.
    const undo = await film(async () => {
      if (item.twice && (await locator.count())) await page.mouse.click(x, y);
      else if (item.tag === 'select')
        await locator.evaluate(node => {
          const select = /** @type {HTMLSelectElement} */ (node);
          select.selectedIndex =
            (select.selectedIndex - 1 + select.options.length) % select.options.length;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
      else await page.keyboard.press('Escape');
    });
    report(`  back  ${label}`, undo, path.join(out, `${slug}_back`));
    if (undo.verdict !== 'ok') flagged += 1;
    if (page.url() !== before && !page.url().startsWith(`${base}${route.split('?')[0]}`)) {
      await page.goto(`${base}${route}`);
      await page.waitForTimeout(2500);
    }
  }
}
console.log(`\n${flagged} flagged; frames in ${out}`);
await browser.close();
