#!/usr/bin/env node
/**
 * Films a short scenario in the beta frame by frame (058, investigation aid).
 *
 *   node scripts/motion-film.mjs --space <id> --out <dir> [--steps explorer,tasks,launches,...]
 *
 * For each step it clicks the section tab, records the DevTools screencast for
 * 2.5 s and prints, per frame, how much of the content area changed since the
 * previous frame. A crossfade spreads the change over many frames; content that
 * pops in puts most of it into one. Frames are kept as PNGs for a look.
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
const out = args.out ?? path.join(process.cwd(), 'motion-film');
const steps = (args.steps ?? 'tasks,launches,accounts,members,explorer').split('|');
const TAB = { explorer: 0, tasks: 1, launches: 2, accounts: 3, members: 4 };
const VIEWPORT = { width: 1280, height: 800 };

const browser = await chromium.launch({
  executablePath: chromeExecutable(),
  headless: !args.headed
});
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  // Phases of every view transition, for the timing printed per step.
  const target = /** @type {any} */ (window);
  target.__vt = [];
  const original = document.startViewTransition?.bind(document);
  if (!original) return;
  document.startViewTransition = /** @type {any} */ (
    (/** @type {any} */ update) => {
      const t = () => Math.round(performance.now());
      const entry = { start: t(), done: 0, ready: 0, finished: 0 };
      target.__vt.push(entry);
      const transition = original(async () => {
        await update?.();
        entry.done = t();
      });
      transition.ready.then(() => (entry.ready = t())).catch(() => {});
      transition.finished.then(() => (entry.finished = t())).catch(() => {});
      return transition;
    }
  );
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await signIn(page, base, supabaseEnv(), args.email ?? 'beta@soty.local');
await page.goto(`${base}/team/${args.space}`);
await page.waitForTimeout(4000);
for (const step of steps) {
  const dir = path.join(out, String(steps.indexOf(step)).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
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
    ...{ maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height }
  });
  await page.waitForTimeout(300);
  const t0 = Date.now();
  const perf0 = await page.evaluate(() => {
    /** @type {any} */ (window).__vt = [];
    return performance.now();
  });
  if (step === 'idle') {
    // Nothing pressed: whatever moves is the page updating itself.
  } else if (step.startsWith('dbl:')) {
    await page.locator(step.slice(4)).first().dblclick();
  } else if (step.startsWith('key:')) {
    await page.keyboard.press(step.slice(4));
  } else if (step.startsWith('click:')) {
    await page.locator(step.slice(6)).first().click();
  } else if (step === 'back') {
    await page.goBack();
  } else if (step.startsWith('/'))
    await page.evaluate(p => /** @type {any} */ (window).__sotyNavigate?.(p), step);
  else await page.locator('a.ui-tab').nth(TAB[step]).click();
  await page.waitForTimeout(Number(args.ms ?? 2500));
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  const rect = { x: 0, y: 150, width: VIEWPORT.width, height: VIEWPORT.height - 150 };
  let previous = null;
  const rows = [];
  frames.forEach((frame, index) => {
    const png = PNG.sync.read(frame.buffer);
    const luma = lumaOf(png.data, png.width, rect, 3);
    const at = Math.round(frame.wall - t0);
    const step = previous ? distance(previous, luma) : 0;
    let mean = 0;
    for (const value of luma) mean += value;
    mean /= luma.length;
    rows.push({ index, at, step: Math.round(step * 100) / 100, mean: Math.round(mean * 10) / 10 });
    writeFileSync(path.join(dir, `${String(index).padStart(3, '0')}_${at}ms.png`), frame.buffer);
    previous = luma;
  });
  const phases = await page.evaluate(since => {
    const target = /** @type {{ __vt?: any[] }} */ (/** @type {unknown} */ (window));
    return (target.__vt ?? []).map(
      (/** @type {any} */ e) =>
        `vt@${Math.round(e.start - since)} held ${e.done - e.start}ms, animating ${e.ready ? e.ready - e.start : '-'}…${e.finished ? e.finished - e.start : '-'}ms`
    );
  }, perf0);
  const total = rows.reduce((sum, row) => sum + row.step, 0);
  const big = rows.filter(row => row.step > 1).map(row => `${row.index}@${row.at}ms:${row.step}`);
  console.log(
    `${step}: ${rows.length} frames, total change ${total.toFixed(1)}, steps>1: ${big.join(' ')}`
  );
  if (phases.length) console.log(`  ${phases.join(' | ')}`);
  writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(rows));
  await page.waitForTimeout(600);
}
await browser.close();
