#!/usr/bin/env node
/**
 * Frame-by-frame transition smoke test for the beta stack (058, FR-027).
 *
 * Drives a separate Chromium (its own socket pool, its own storage — never the
 * person's Chrome), signs in as the beta tester with a local magic link, and
 * records every key transition with the DevTools screencast. Each transition
 * is judged on the content area below the topbar (scripts/lib/motion-metric.mjs):
 * no frame may leave the path from the old screen to the new one (a blank, a
 * flash of the background, a stray placeholder), the screen must settle within
 * its budget, and layout must not shift after it lands.
 *
 *   node scripts/motion-smoke.mjs [--base http://127.0.0.1:5175] [--out <dir>]
 *        [--email beta@soty.local] [--reduced] [--headed] [--pass cold|warm|both]
 *
 * Writes <out>/report.json and, per transition, the start, end and worst frame.
 * Exits 1 when any transition fails. Tokens and keys are never printed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { analyzeTransition, lumaOf } from './lib/motion-metric.mjs';

/**
 * What the page under test carries for this script: the dev-only router hook
 * (lib/navigation.ts) and the layout shifts the init script collects.
 * @typedef {Window & {
 *   __motionShifts?: Array<{ t: number, v: number }>,
 *   __sotyNavigate?: (route: string) => void
 * }} SmokeWindow
 */
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VIEWPORT = { width: 1440, height: 900 };
const BUDGET_MS = { page: 900, section: 700, overlay: 700, pop: 900 };
const SHIFT_MAX = 0.05;
const RECORD_MS = 1_600;

function parseArgs(argv) {
  const args = {
    base: 'http://127.0.0.1:5175',
    out: path.join(tmpdir(), 'soty-motion-smoke', new Date().toISOString().replace(/[:.]/gu, '-')),
    email: 'beta@soty.local',
    reduced: false,
    headed: false,
    pass: 'both'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => argv[++index];
    if (flag === '--base') args.base = next();
    else if (flag === '--out') args.out = path.resolve(next());
    else if (flag === '--email') args.email = next();
    else if (flag === '--reduced') args.reduced = true;
    else if (flag === '--headed') args.headed = true;
    else if (flag === '--pass') args.pass = next();
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

function chromeExecutable() {
  if (process.env.PLAYWRIGHT_CHROME) return process.env.PLAYWRIGHT_CHROME;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  for (const build of readdirSync(cache)
    .filter(entry => entry.startsWith('chromium-'))
    .sort()
    .reverse()) {
    for (const suffix of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-linux/chrome'
    ]) {
      const candidate = path.join(cache, build, suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function supabaseEnv() {
  const output = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const env = {};
  for (const line of output.split('\n')) {
    const match = /^([A-Z_]+)="?(.*?)"?$/u.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  if (!env.API_URL || !env.ANON_KEY || !env.SERVICE_ROLE_KEY)
    throw new Error('supabase status did not return API_URL, ANON_KEY and SERVICE_ROLE_KEY');
  return { api: env.API_URL, anon: env.ANON_KEY, service: env.SERVICE_ROLE_KEY };
}

function agentToken() {
  const file = path.join(homedir(), 'Library/Application Support/Soty Beta/session-token.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed === 'string') return parsed;
    return parsed.token ?? parsed.sessionToken ?? parsed.value ?? null;
  } catch {
    return null;
  }
}

async function signIn(page, base, supabase, email) {
  const response = await fetch(`${supabase.api}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: supabase.service,
      Authorization: `Bearer ${supabase.service}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ type: 'magiclink', email })
  });
  if (!response.ok) throw new Error(`generate_link failed: HTTP ${response.status}`);
  const link = await response.json();
  const tokenHash = link.hashed_token ?? link.properties?.hashed_token;
  if (!tokenHash) throw new Error('generate_link returned no token hash');
  await page.goto(`${base}/login`);
  const signedIn = await page.evaluate(
    async ({ api, anon, hash }) => {
      const verify = await fetch(`${api}/auth/v1/verify`, {
        method: 'POST',
        headers: { apikey: anon, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'magiclink', token_hash: hash })
      });
      const session = await verify.json();
      if (!session.access_token) return false;
      localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
      return true;
    },
    { api: supabase.api, anon: supabase.anon, hash: tokenHash }
  );
  if (!signedIn) throw new Error('magic link verification returned no session');
  const token = agentToken();
  await page.goto(token ? `${base}/#agentToken=${encodeURIComponent(token)}` : `${base}/`);
  await page.waitForSelector('header.topbar', { timeout: 30_000 });
}

function decode(buffer) {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

async function contentRect(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('header.topbar')?.getBoundingClientRect();
    const top = Math.ceil(bar ? bar.bottom : 0);
    return { x: 0, y: top, width: window.innerWidth, height: window.innerHeight - top };
  });
}

async function record(page, cdp, out, transition) {
  const frames = [];
  const onFrame = ({ data, metadata, sessionId }) => {
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
  await page.waitForTimeout(250);
  const rect = await contentRect(page);
  const startShot = await page.screenshot();
  const triggerPerf = await page.evaluate(() => performance.now());
  const triggerWall = Date.now();
  await transition.trigger(page);
  await page.waitForTimeout(RECORD_MS);
  if (transition.waitFor) await transition.waitFor(page);
  const endShot = await page.screenshot();
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  const shift = await page.evaluate(
    since =>
      (/** @type {SmokeWindow} */ (/** @type {unknown} */ (window)).__motionShifts ?? [])
        .filter(entry => entry.t >= since)
        .reduce((sum, entry) => sum + entry.v, 0),
    triggerPerf + 500
  );

  const start = decode(startShot);
  const end = decode(endShot);
  const lumaStart = lumaOf(start.data, start.width, rect);
  const lumaEnd = lumaOf(end.data, end.width, rect);
  const usable = [];
  let skipped = 0;
  for (const frame of frames) {
    if (frame.wall < triggerWall) continue;
    const image = decode(frame.buffer);
    if (image.width !== start.width || image.height !== start.height) {
      skipped += 1;
      continue;
    }
    usable.push({
      at: Math.round(frame.wall - triggerWall),
      luma: lumaOf(image.data, image.width, rect),
      buffer: frame.buffer
    });
  }
  const result = analyzeTransition({ start: lumaStart, end: lumaEnd, frames: usable });
  const budget = BUDGET_MS[transition.kind];
  const failures = [];
  if (result.dipped)
    failures.push(`frame ${result.worstAt}ms leaves the path (excess ${result.worstExcess})`);
  if (result.settledMs > budget)
    failures.push(`settles at ${result.settledMs}ms (budget ${budget}ms)`);
  if (shift > SHIFT_MAX) failures.push(`layout shifts ${shift.toFixed(3)} after landing`);

  const slug = transition.name.replace(/[^a-z0-9]+/giu, '-').toLowerCase();
  writeFileSync(path.join(out, `${slug}-start.png`), startShot);
  writeFileSync(path.join(out, `${slug}-end.png`), endShot);
  if (result.worstIndex >= 0)
    writeFileSync(path.join(out, `${slug}-worst.png`), usable[result.worstIndex].buffer);
  return {
    name: transition.name,
    kind: transition.kind,
    ...result,
    skippedFrames: skipped,
    layoutShift: Math.round(shift * 1000) / 1000,
    budgetMs: budget,
    ok: failures.length === 0,
    failures
  };
}

const go = route => page =>
  page.evaluate(
    target => /** @type {SmokeWindow} */ (/** @type {unknown} */ (window)).__sotyNavigate?.(target),
    route
  );

const tab = section => async page => {
  await page.locator(`.team-space-tabs a[href*="/${section}"]`).first().click();
};

async function spaceBase(page) {
  const url = new URL(page.url());
  const match = /^\/team\/([^/]+)/u.exec(url.pathname);
  return match ? `/team/${match[1]}` : null;
}

function transitions(space) {
  const list = [
    { name: 'home to compressor', kind: 'page', trigger: go('/compressor') },
    { name: 'compressor to account', kind: 'page', trigger: go('/account') },
    { name: 'account to home', kind: 'page', trigger: go('/') }
  ];
  if (!space) return list;
  return [
    ...list,
    { name: 'home to space', kind: 'page', trigger: go(`${space}/explorer`) },
    { name: 'files to tasks', kind: 'section', trigger: tab('tasks') },
    { name: 'tasks to launches', kind: 'section', trigger: tab('launches') },
    { name: 'launches to accounts', kind: 'section', trigger: tab('accounts') },
    { name: 'accounts to members', kind: 'section', trigger: tab('members') },
    { name: 'members to files', kind: 'section', trigger: tab('explorer') },
    {
      name: 'open space settings',
      kind: 'overlay',
      trigger: go(`${space}/explorer?settings=1`)
    },
    {
      name: 'close space settings',
      kind: 'overlay',
      trigger: page => page.keyboard.press('Escape')
    },
    { name: 'space to compressor', kind: 'page', trigger: go('/compressor') },
    { name: 'back to space', kind: 'pop', trigger: page => page.evaluate(() => history.back()) }
  ];
}

async function runPass(browser, args, supabase, label) {
  const out = path.join(args.out, label);
  mkdirSync(out, { recursive: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: args.reduced ? 'reduce' : 'no-preference'
  });
  await context.addInitScript(() => {
    // Runs in the page: nothing from this module is in scope there.
    const target = /** @type {SmokeWindow} */ (/** @type {unknown} */ (window));
    const shifts = /** @type {Array<{ t: number, v: number }>} */ ([]);
    target.__motionShifts = shifts;
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const shift =
            /** @type {PerformanceEntry & { hadRecentInput?: boolean, value?: number }} */ (entry);
          if (!shift.hadRecentInput) shifts.push({ t: shift.startTime, v: shift.value ?? 0 });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // No layout-shift entries in this engine; the shift check reads zero.
    }
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await signIn(page, args.base, supabase, args.email);
  await page.evaluate(() =>
    /** @type {SmokeWindow} */ (/** @type {unknown} */ (window)).__sotyNavigate?.('/team')
  );
  await page.waitForURL(/\/team\/[^/?#]+/u, { timeout: 20_000 }).catch(() => undefined);
  const space = await spaceBase(page);
  await page.evaluate(() =>
    /** @type {SmokeWindow} */ (/** @type {unknown} */ (window)).__sotyNavigate?.('/')
  );
  await page.waitForTimeout(800);

  const results = [];
  for (const transition of transitions(space)) {
    try {
      results.push(await record(page, cdp, out, transition));
    } catch (error) {
      results.push({
        name: transition.name,
        kind: transition.kind,
        frames: 0,
        direct: 0,
        worstExcess: 0,
        worstAt: null,
        worstIndex: -1,
        settledMs: 0,
        dipped: false,
        skippedFrames: 0,
        layoutShift: 0,
        budgetMs: BUDGET_MS[transition.kind],
        ok: false,
        failures: [error instanceof Error ? error.message : String(error)]
      });
    }
  }
  await context.close();
  return { label, space: Boolean(space), results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const supabase = supabaseEnv();
  const browser = await chromium.launch({
    headless: !args.headed,
    executablePath: chromeExecutable()
  });
  const passes = [];
  try {
    // Cold: a fresh context, nothing cached. Warm: the same walk again.
    if (args.pass !== 'warm') passes.push(await runPass(browser, args, supabase, 'cold'));
    if (args.pass !== 'cold') passes.push(await runPass(browser, args, supabase, 'warm'));
  } finally {
    await browser.close();
  }
  const report = { base: args.base, reduced: args.reduced, at: new Date().toISOString(), passes };
  writeFileSync(path.join(args.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  let failed = 0;
  for (const pass of passes) {
    console.log(
      `\n${pass.label}${pass.space ? '' : ' (no space found — workspace transitions skipped)'}`
    );
    for (const result of pass.results) {
      if (!result.ok) failed += 1;
      const detail = result.ok
        ? `excess ${result.worstExcess} · settled ${result.settledMs}ms · shift ${result.layoutShift} · ${result.frames} frames`
        : result.failures.join('; ');
      console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name.padEnd(24)} ${detail}`);
    }
  }
  console.log(`\nreport: ${path.join(args.out, 'report.json')}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
