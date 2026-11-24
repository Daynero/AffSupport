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
 * And, for the one search (070, US3), at every width:
 *  - ticking a row's box brings the selection bar into the strip above the list, and neither the
 *    toolbar nor the first row moves by a pixel, nor is the bar inside the toolbar;
 *  - typing in the toolbar's box shows the results in the list's place — the toolbar, its one
 *    search box and its row stay where they were, and no second field appears;
 *  - with results, Down hands the keyboard to them and the details pane shows the focused one;
 *  - emptying the box gives the folder back.
 * A beta whose search catalog is empty (Drive waiting for a person) has nothing to show there:
 * `--fake-search` answers the search in this browser only, from the rows of the folder it opened
 * (pass `--folder=` with files in it).
 *
 * Usage: node scripts/check-explorer-layout.mjs [teamId] [--site=http://127.0.0.1:5175]
 *        [--storage-state=/path/to/local-auth.json] [--folder=<drive folder id>]
 *        [--back=<task id>] [--theme=light|dark] [--widths=360,768,1024,1440]
 *        [--fake-search] [--no-search]
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

const teamId = () => opened.teamId;
const opened = await openLocalBrowser(args, {
  defaultTeam: '22222222-2222-4222-8222-222222222222',
  path: teamId => `/team/${teamId}/explorer?${query}`,
  ready: '.team-explorer-toolbar',
  viewport: { width: 1440, height: 900 }
});
const { browser, page } = opened;
const failures = [];
const checkSearch = !args.includes('--no-search');
if (args.includes('--fake-search')) await fakeSearch(page, teamId());
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
    if (checkSearch) {
      const search = await searchAndSelection(page);
      const searchOk = search.problems.length === 0;
      if (!searchOk) failures.push({ width, search });
      console.log(JSON.stringify({ width, searchOk, ...search }));
    }
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

/** Where the toolbar, the strip and the first row are, to the pixel. */
function places(page) {
  return page.evaluate(() => {
    const top = selector => {
      const element = document.querySelector(selector);
      return element ? Math.round(element.getBoundingClientRect().top + window.scrollY) : null;
    };
    return {
      toolbar: top('.team-explorer-toolbar'),
      strip: top('.team-explorer-list-controls'),
      firstRow: top('.team-explorer-rows .ui-table-row'),
      stripHeight: Math.round(
        document.querySelector('.team-explorer-list-controls')?.getBoundingClientRect().height ?? 0
      )
    };
  });
}

/** 070 US3: the selection bar moves nothing; typing searches in place; the pane follows. */
async function searchAndSelection(page) {
  const problems = [];
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  // The selection: a row's box, ticked and let go.
  const before = await places(page);
  const box = page.locator('.team-explorer-rows .team-explorer-row-check input').first();
  if (await box.count()) {
    await box.check({ force: true });
    const bar = page.getByRole('toolbar', { name: /Дії з вибраним|What to do with the selection/ });
    await bar.waitFor({ timeout: 5000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const during = await places(page);
    for (const key of ['toolbar', 'strip', 'firstRow', 'stripHeight']) {
      if (before[key] !== during[key])
        problems.push(`selection moved ${key}: ${before[key]} → ${during[key]}`);
    }
    if (await bar.evaluate(element => Boolean(element.closest('.team-explorer-toolbar')))) {
      problems.push('selection bar inside the toolbar');
    }
    await bar.getByRole('button', { name: /Скинути вибір|Clear selection/ }).click();
    await bar.waitFor({ state: 'detached', timeout: 5000 });
  }
  // The search, typed where the toolbar keeps it.
  let field = page.locator('.team-explorer-search input');
  if (
    !(await field
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    await page.locator('body').press('/');
    await page.waitForTimeout(300);
  }
  field = page.locator('.team-explorer-search input').first();
  if (!(await field.isVisible().catch(() => false))) {
    problems.push('no search box after `/`');
    return { problems };
  }
  const toolbarBefore = (await places(page)).toolbar;
  await field.fill('TR');
  await page
    .locator('.team-explorer-results, .team-catalog.is-embedded .ui-empty')
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => problems.push('typing showed neither results nor an empty state'));
  const after = await places(page);
  if (after.toolbar !== toolbarBefore)
    problems.push(`typing moved the toolbar: ${toolbarBefore} → ${after.toolbar}`);
  if ((await page.getByRole('searchbox').count()) !== 1) problems.push('a second search field');
  if (!(await page.locator('.team-explorer-main .team-catalog.is-embedded').count())) {
    problems.push('results are not in the list area');
  }
  const results = await page.locator('.team-explorer-results .team-explorer-row').count();
  let pane = false;
  if (results > 0) {
    await field.press('ArrowDown');
    pane = await page
      .locator('.team-explorer-pane-host .team-explorer-pane')
      .waitFor({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!pane) problems.push('no details pane for the focused result');
    await page.locator('.team-explorer-search input').first().fill('');
  } else {
    await field.fill('');
  }
  // Escape on the empty box puts it away — on a short row, the path comes back.
  await page.keyboard.press('Escape');
  await page
    .locator('.team-explorer-results, .team-catalog.is-embedded')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => problems.push('emptying the box did not give the folder back'));
  await settle(page);
  return { results, pane, problems };
}

/**
 * The search answered from the folder this browser opened, for a beta whose catalog is empty —
 * in this browser only, the way the layout is read; nothing is written anywhere.
 */
async function fakeSearch(page, team) {
  await page.waitForSelector('.team-explorer-row[data-material-id]', { timeout: 15000 });
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.team-explorer-row[data-material-id]')).map(row => ({
      id: row.getAttribute('data-material-id'),
      name: row.querySelector('.team-explorer-row-open')?.textContent ?? ''
    }))
  );
  await page.route('**/rest/v1/rpc/search_materials', async route => {
    const body = route.request().postDataJSON() ?? {};
    const words = String(
      Object.entries(body).find(([key]) => /query/i.test(key))?.[1] ?? ''
    ).toLowerCase();
    const items = rows
      .filter(row => !words || row.name.toLowerCase().includes(words))
      .slice(0, 50)
      .map(row => ({
        id: row.id,
        teamId: team,
        parentFolderId: folder ?? null,
        name: row.name,
        kind: 'file',
        category: 'video',
        mimeType: 'video/mp4',
        fileExtension: 'mp4',
        classificationVersion: 1,
        classificationSource: 'mime',
        sizeBytes: 1_000_000,
        modifiedAt: '2026-11-11T10:00:00Z',
        geo: null,
        language: null,
        offer: null,
        tags: [],
        transcriptIngestState: 'not_applicable',
        transcriptTruncated: false,
        previewState: 'ready',
        lineage: { hasSource: false, hasDerivatives: false, isVersion: false },
        matchedIn: 'name'
      }));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items,
        total: items.length,
        facets: {},
        activeFilters: {},
        catalogFreshness: {
          state: 'ready',
          lastSyncedAt: null,
          discoveredCount: items.length,
          foldersRemaining: null,
          lastProgressAt: null
        }
      })
    });
  });
}
