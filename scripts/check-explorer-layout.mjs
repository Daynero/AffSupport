#!/usr/bin/env node
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * 070 SC-001: the explorer's toolbar is one row with at most one primary, at every width from
 * a phone to a wide screen, and nothing that leaves the row loses its name.
 *
 * For each width it reads the real page and checks that:
 *  - every visible control of the toolbar sits on one line (their vertical centres agree) and
 *    the row is no taller than one control;
 *  - the row does not overflow itself and the page does not scroll sideways;
 *  - there is at most one filled primary (`Upload`, or its named "+" plate on a phone);
 *  - every visible button in the row has a name (text or `aria-label`);
 *  - the "…" menu opens and every item in it has words.
 *
 * Local sites only, as the accounts check: a running beta (`npm run dev:beta`, the beta owner's
 * sign-in) or a development server answering from memory, which needs no database or agent:
 *
 *   VITE_MOCK_DATA=true VITE_LOCAL_DEV_AUTH=true VITE_SUPABASE_URL=http://127.0.0.1:54399 \
 *   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_local_mock_key VITE_SITE_URL=http://127.0.0.1:5199 \
 *   npx vite --host 127.0.0.1 --port 5199 (in apps/web)
 *   node scripts/check-explorer-layout.mjs 11111111-1111-4111-8111-111111111111 --site=http://127.0.0.1:5199
 *
 * Usage: node scripts/check-explorer-layout.mjs [teamId] [--site=http://127.0.0.1:5175]
 *        [--storage-state=/path/to/local-auth.json] [--folder=<drive folder id>]
 *        [--back=<task id>] [--theme=light|dark] [--widths=360,768,1024,1440]
 */
import { openLocalBrowser } from './lib/accounts-browser.mjs';

const args = process.argv.slice(2);
const WIDTHS = (
  args.find(arg => arg.startsWith('--widths='))?.slice(9) ?? '360,390,768,1024,1280,1440'
)
  .split(',')
  .map(Number)
  .filter(width => Number.isFinite(width) && width > 0);
const folder = args.find(arg => arg.startsWith('--folder='))?.slice(9);
const back = args.find(arg => arg.startsWith('--back='))?.slice(7);
const query = new URLSearchParams({
  view: 'list',
  ...(folder ? { folder } : {}),
  // `--back=<task id>`: the row with the way back to a task, its widest everyday form.
  ...(back ? { back } : {})
});

/** Settled: the crossfade copies (058, `lib/auto-crossfade.ts`) are gone and the row has measured. */
const settle = page =>
  page.waitForFunction(() => !document.querySelector('.team-explorer [inert]'), null, {
    timeout: 5000
  });

const { browser, page } = await openLocalBrowser(args, {
  defaultTeam: '22222222-2222-4222-8222-222222222222',
  path: teamId => `/team/${teamId}/explorer?${query}`,
  ready: '.team-explorer-toolbar',
  viewport: { width: 1440, height: 900 }
});
const failures = [];
try {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // The row measures itself on resize; two frames let it settle.
    await page.evaluate(
      () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await settle(page);
    const seen = await page.evaluate(() => {
      const bar = document.querySelector('.team-explorer-toolbar');
      if (!(bar instanceof HTMLElement)) throw new Error('Explorer toolbar missing');
      const shown = element => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          box.width > 0 &&
          box.height > 0 &&
          style.visibility !== 'hidden' &&
          // A crossfade copy laid over the row for a moment is not one of its controls.
          !element.closest('[inert]')
        );
      };
      // The row's own controls; the selection bar lies over the row only while files are chosen.
      const controls = [
        ...bar.querySelectorAll('button, a[href], input, [role="radiogroup"], [role="separator"]')
      ].filter(element => shown(element) && !element.closest('.team-explorer-selection-bar'));
      const centres = controls.map(element => {
        const box = element.getBoundingClientRect();
        return Math.round((box.top + box.bottom) / 2);
      });
      const spread = centres.length ? Math.max(...centres) - Math.min(...centres) : 0;
      const tallest = Math.max(
        0,
        ...controls.map(element => element.getBoundingClientRect().height)
      );
      const height = bar.getBoundingClientRect().height;
      const primaries = [
        ...bar.querySelectorAll(
          '.ui-color-primary.ui-button--solid, .ui-color-primary.ui-icon-button--solid'
        )
      ].filter(shown).length;
      const unnamed = [...bar.querySelectorAll('button, a[href]')]
        .filter(element => shown(element) && !element.closest('.team-explorer-selection-bar'))
        .filter(
          element =>
            !(element.getAttribute('aria-label') ?? '').trim() &&
            !(element.getAttribute('aria-labelledby') ?? '').trim() &&
            !(element.textContent ?? '').trim()
        )
        .map(element => element.outerHTML.slice(0, 80));
      return {
        fit: bar.dataset.fit ?? null,
        rowWidth: Math.round(bar.getBoundingClientRect().width),
        rowHeight: Math.round(height),
        controls: controls.length,
        spread,
        tallerThanOneControl: height > tallest + 2,
        rowOverflow: bar.scrollWidth - bar.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        primaries,
        unnamed
      };
    });

    // The "…" opens, and what it holds is in words.
    let menu = [];
    const more = page.locator('.team-explorer-toolbar .team-explorer-more:not([inert] *)');
    if (await more.count()) {
      await more.first().click();
      const items = page.getByRole('menuitem');
      await items.first().waitFor({ timeout: 5000 });
      menu = await items.allTextContents();
      await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'detached', timeout: 5000 });
      await settle(page);
    }
    const wordless = menu.filter(text => !text.replace('✓', '').trim());

    const ok =
      seen.controls > 0 &&
      seen.spread <= 2 &&
      !seen.tallerThanOneControl &&
      seen.rowOverflow <= 1 &&
      seen.pageOverflow <= 1 &&
      seen.primaries <= 1 &&
      seen.unnamed.length === 0 &&
      menu.length > 0 &&
      wordless.length === 0;
    if (!ok) failures.push({ width, ...seen, menu });
    console.log(JSON.stringify({ width, ok, ...seen, menu }));
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`Explorer toolbar failed at widths: ${failures.map(f => f.width).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(
    `PASS: the explorer toolbar is one row with at most one primary at ${WIDTHS.join(', ')} px, and every control that left the row is a named item of "…".`
  );
}
