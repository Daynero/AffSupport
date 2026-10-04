// Real local Auth + finance RPCs.
// The actual AccountSpace is mounted with its real team context. Top-level
// route navigation and the local agent bridge are not exercised here.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const connectionString =
  process.env.FINANCE_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname))
  throw new Error('LOCAL_DATABASE_REQUIRED');
const db = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
let team;
let browser;
let verified = false;
await db.connect();
try {
  const owner = (await db.query("select id from auth.users where email='beta@soty.local'")).rows[0]
    ?.id;
  if (!owner) throw new Error('BETA_FIXTURE_REQUIRED');
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [owner, JSON.stringify({ sub: owner, role: 'authenticated' })]
  );
  const today = (await db.query("select private.finance_today('UTC')::text as date")).rows[0].date;
  const prior = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  prior.setUTCMonth(prior.getUTCMonth() - 1);
  const priorFirst = prior.toISOString().slice(0, 10);
  const priorDay = `${priorFirst.slice(0, 7)}-10`;
  await db.query('begin');
  try {
    team = (
      await db.query('select id from public.create_team($1)', [
        `Finance browser validation ${randomUUID()}`
      ])
    ).rows[0].id;
    const accounts = [];
    for (const name of ['Validation X', 'Validation Y'])
      accounts.push(
        (await db.query('select id from public.create_team_account($1,$2)', [team, name])).rows[0]
          .id
      );
    const agents = [];
    for (const id of ['001234', '009876'])
      agents.push(
        (
          await db.query("select public.add_team_account_agent($1,$2,$3)->>'id' as id", [
            team,
            accounts[0],
            id
          ])
        ).rows[0].id
      );
    // Only our synthetic agents: permit historical fixture entries without
    // changing any production creation-date semantics or existing records.
    await db.query('update public.team_agent_placements set starts_on=$1 where team_id=$2', [
      priorFirst,
      team
    ]);
    const set = (agent, date, metric, value) =>
      db.query('select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8)', [
        team,
        agent,
        date,
        metric,
        value,
        '0',
        'UTC',
        randomUUID()
      ]);
    await set(agents[0], priorDay, 'spend', '100.10');
    await set(agents[1], priorDay, 'spend', '40.20');
    await set(agents[0], today, 'balance', '70.00');
    await set(agents[0], today, 'topup', '200.00');
    await set(agents[0], today, 'spend', '125.50');
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
  browser = await chromium.launch({
    executablePath:
      process.env.FINANCE_CHROMIUM_PATH ??
      '/Users/daynero/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5175/login');
  await page.getByRole('button', { name: /beta/i }).click();
  await page.waitForURL(url => url.pathname !== '/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate(async teamId => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const source = '/src/team/accounts/AccountSpace.tsx';
    const code = await (await fetch(source)).text();
    const { ToastProvider } = await import(code.match(/import \{ useToasts \} from "([^"]+)"/)[1]);
    const { AccountSpace } = await import(source);
    const { TeamProvider } = await import(code.match(/import \{ useTeam \} from "([^"]+)"/)[1]);
    const accountsCode = await (await fetch('/src/team/accounts/useAccounts.ts')).text();
    const { teamApi } = await import(accountsCode.match(/import \{ teamApi \} from "([^"]+)"/)[1]);
    const teams = await teamApi.listTeams();
    localStorage.setItem('wishly.active-team.v1', teamId);
    document.getElementById('root').style.display = 'none';
    const host = document.createElement('main');
    host.className = 'team-panel';
    document.body.append(host);
    ReactDOM.createRoot(host).render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(
          TeamProvider,
          { initialTeams: teams, realtime: false },
          React.createElement(AccountSpace, { teamId })
        )
      )
    );
  }, team);
  await page.getByRole('button', { name: /^(Щоденні фінанси|Daily finances)$/ }).click();
  const spend = page.getByRole('textbox', { name: /001234.*Spend/ });
  await spend.waitFor();
  assert.equal(await spend.inputValue(), '125.50');
  await spend.fill('150,25');
  await spend.press('Enter');
  const waitValue = async (id, value) =>
    page.waitForFunction(
      ([id, value]) =>
        Array.from(document.querySelectorAll('input')).some(
          input =>
            input.getAttribute('aria-label')?.startsWith(id) &&
            input.getAttribute('aria-label')?.includes('Spend') &&
            input.value === value
        ),
      [id, value]
    );
  await waitValue('001234', '150.25');
  console.log('PASS: exact comma amount, real write and authoritative reread');
  const parity = await page.evaluate(() => {
    const finance = document.querySelector('.finance-daily-row');
    const operational = document.querySelector('.team-agent-row:not(.finance-daily-row)');
    const compare = (selector, property) =>
      getComputedStyle(finance.querySelector(selector))[property] ===
      getComputedStyle(operational.querySelector(selector))[property];
    return {
      height: getComputedStyle(finance).minHeight === getComputedStyle(operational).minHeight,
      identity: compare('.team-agent-tag', 'fontSize'),
      rail: compare('.team-agent-rail', 'backgroundColor'),
      heading:
        getComputedStyle(finance.closest('.team-account').querySelector('.team-account-head'))
          .backgroundImage ===
        getComputedStyle(operational.closest('.team-account').querySelector('.team-account-head'))
          .backgroundImage
    };
  });
  assert.ok(Object.values(parity).every(Boolean), JSON.stringify(parity));
  console.log(
    'PASS: finance and operational rows share height, identity typography, account rail and heading'
  );
  await spend.fill('-1');
  await spend.press('Tab');
  assert.equal(await spend.getAttribute('aria-invalid'), 'true');
  assert.equal(await spend.evaluate(input => document.activeElement === input), true);
  await spend.press('Escape');
  console.log('PASS: invalid Tab retains focus; Escape restores the saved value');
  await spend.fill('175.00');
  await page.getByRole('button', { name: /^(Агенти та запуски|Agents and runs)$/ }).click();
  assert.equal(await spend.isVisible(), false);
  await page.getByRole('button', { name: /^(Щоденні фінанси|Daily finances)$/ }).click();
  assert.equal(await spend.inputValue(), '175.00');
  await spend.press('Escape');
  console.log('PASS: switching between actual account views retains a financial draft');
  await spend.fill('150,25');
  await page.getByRole('button', { name: /^(Попередній період|Previous period)$/ }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^(Зберегти й продовжити|Save and continue)$/ })
    .click();
  await waitValue('001234', '');
  await page.getByRole('button', { name: /^(Наступний період|Next period)$/ }).click();
  await waitValue('001234', '150.25');
  console.log('PASS: another day is empty; returning retains all saved values');
  console.log('PASS: save-all navigation waits for the authoritative financial write');
  await spend.fill('');
  await spend.press('Enter');
  await page
    .getByRole('dialog')
    .last()
    .getByRole('button', { name: /^(Зберегти|Save)$/ })
    .click();
  await waitValue('001234', '');
  await page.getByRole('button', { name: /^(Скасувати очищення|Undo)$/ }).click();
  await waitValue('001234', '150.25');
  console.log('PASS: single spend clear + server-backed Undo');
  const clearRequests = [];
  let responseLost;
  const droppedResponse = new Promise(resolve => {
    responseLost = resolve;
  });
  await page.route('**/rest/v1/rpc/clear_team_agent_finance_values', async route => {
    clearRequests.push(route.request().postDataJSON());
    if (clearRequests.length === 1) {
      await route.fetch();
      await route.abort('failed');
      responseLost();
    } else await route.continue();
  });
  await page
    .getByRole('button', { name: /^(Дії за обраний день|Actions for the selected day)$/ })
    .click();
  await page
    .getByRole('menuitem', { name: /^(Очистити залишки за цей день|Clear balances for this day)$/ })
    .click();
  const batch = page.getByRole('dialog').last();
  await batch
    .getByRole('button', { name: /^(Очистити залишки за цей день|Clear balances for this day)$/ })
    .click();
  await droppedResponse;
  await batch
    .getByRole('button', { name: /^(Очистити залишки за цей день|Clear balances for this day)$/ })
    .click();
  await page
    .getByRole('dialog', { name: /^(Очистити залишки за цей день|Clear balances for this day)$/ })
    .waitFor({ state: 'hidden' });
  assert.equal(clearRequests.length, 2);
  assert.deepEqual(clearRequests[0], clearRequests[1]);
  await page.getByRole('button', { name: /^(Скасувати очищення|Undo)$/ }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('input')).some(
      input => input.getAttribute('aria-label')?.startsWith('001234') && input.value === '70.00'
    )
  );
  console.log('PASS: lost batch response retries the exact receipt and preserves Undo');
  await page.getByRole('searchbox').fill('001234');
  assert.equal(await page.getByRole('textbox', { name: /009876.*Spend/ }).count(), 0);
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: /^(Минулий місяць|Previous month)$/ }).click();
  await page.getByRole('table').waitFor();
  await page.getByText('140.30 USD', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: priorDay, exact: true }).click();
  await waitValue('001234', '100.10');
  await page
    .getByRole('button', { name: /^(Повернутися до місячного звіту|Back to monthly report)$/ })
    .click();
  await page.getByRole('table').waitFor();
  assert.equal(
    await page
      .getByRole('tab', { name: /^(Місячна таблиця|Monthly matrix)$/ })
      .getAttribute('aria-selected'),
    'true'
  );
  assert.equal(
    await page
      .getByRole('button', { name: priorDay, exact: true })
      .evaluate(button => document.activeElement === button),
    true
  );
  await page.getByRole('button', { name: /^(Сьогодні|Today)$/ }).click();
  await waitValue('001234', '150.25');
  console.log('PASS: prior-month total, historical day drill-down and return to today');
  await page.getByRole('button', { name: /^(Дії для|Actions for) 009876$/ }).click();
  await page.getByRole('menuitem', { name: /Перенести|Move to/ }).click();
  const dialog = page.getByRole('dialog').last();
  await dialog.locator('[aria-haspopup="listbox"]').click();
  await page.getByRole('option', { name: 'Validation Y' }).click();
  await dialog
    .getByRole('button', { name: /^(Перенести на інший соц|Move to another account)$/ })
    .click();
  await page
    .getByRole('region', { name: /^(Щоденні фінанси|Daily finances)$/ })
    .getByLabel('Validation Y-876', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: /^(Історія|History) · 009876$/ }).click();
  await page
    .getByRole('dialog')
    .last()
    .getByText(/Validation X → Validation Y/)
    .waitFor();
  await page
    .getByRole('dialog')
    .last()
    .getByText(/40.20 USD/)
    .waitFor();
  await page.keyboard.press('Escape');
  console.log('PASS: real transfer retains UUID and prior-account financial history');
  assert.equal(await page.getByRole('searchbox').isEnabled(), true);
  const dismiss = page.getByRole('button', { name: /^(Dismiss notification|Закрити сповіщення)$/ });
  while (await dismiss.count()) await dismiss.first().click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({
      path: fileURLToPath(new URL(`finance-real-${theme}-390.png`, import.meta.url)),
      fullPage: true
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    assert.equal(overflow, 0);
    await page.getByRole('button', { name: /^(Цей місяць|This month)$/ }).click();
    const matrix = page.getByRole('region', { name: /^(Місячна таблиця|Monthly matrix)$/ });
    await matrix.waitFor();
    const scroll = await matrix.evaluate(element => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      height: element.clientHeight,
      scrollHeight: element.scrollHeight
    }));
    assert.ok(scroll.scrollWidth > scroll.width);
    assert.ok(scroll.scrollHeight > scroll.height);
    const headerBefore = await matrix.locator('[role="columnheader"]').first().boundingBox();
    await matrix.evaluate(element => {
      element.scrollLeft = 150;
      element.scrollTop = 100;
    });
    const headerAfter = await matrix.locator('[role="columnheader"]').first().boundingBox();
    assert.ok(Math.abs(headerBefore.x - headerAfter.x) < 2);
    assert.ok(Math.abs(headerBefore.y - headerAfter.y) < 2);
    const footer = await matrix.locator('.finance-matrix-total').boundingBox();
    const region = await matrix.boundingBox();
    assert.ok(
      footer.y >= region.y && footer.y + footer.height <= region.y + region.height + 2,
      'Totals stay visible while scrolling'
    );
    const layers = await matrix.evaluate(element => {
      const header = element.querySelector('.ui-table-header');
      const date = element.querySelector('.ui-table-row .finance-matrix-date');
      return {
        header: Number(getComputedStyle(header).zIndex),
        date: Number(getComputedStyle(date).zIndex)
      };
    });
    assert.ok(layers.header > layers.date, 'Sticky dates cannot paint above the header');
    await page.screenshot({
      path: fileURLToPath(new URL(`finance-real-month-${theme}-390.png`, import.meta.url)),
      fullPage: true
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      ),
      0
    );
    await page.getByRole('button', { name: /^(Сьогодні|Today)$/ }).click();
    await waitValue('001234', '150.25');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: no browser runtime errors');
  if (process.env.FINANCE_CHECK_EXPORT === '1') {
    if (process.env.FINANCE_NATIVE_EDGE_URL) {
      const native = new URL(process.env.FINANCE_NATIVE_EDGE_URL);
      if (native.origin !== 'http://127.0.0.1:54329') throw new Error('LOCAL_NATIVE_EDGE_REQUIRED');
      await page.route('**/functions/v1/team-finance-export', async route => {
        const upstream = await route.fetch({
          url: native.href,
          headers: route.request().headers()
        });
        if (upstream.status() !== 200)
          console.log({
            nativeStatus: upstream.status(),
            origin: route.request().headers().origin,
            authenticated: Boolean(route.request().headers().authorization),
            errorCode: (await upstream.json().catch(() => null))?.error?.code ?? 'NO_JSON_ERROR'
          });
        const body = await upstream.body();
        console.log({
          nativeBytes: body.length,
          nativeZip: body.subarray(0, 4).toString('hex'),
          encoding: upstream.headers()['content-encoding'] ?? null
        });
        const headers = { ...upstream.headers() };
        delete headers['content-length'];
        delete headers['content-encoding'];
        await route.fulfill({ status: upstream.status(), headers, body });
      });
    }
    const responsePromise = page.waitForResponse(
      response =>
        (response.url().endsWith('/functions/v1/team-finance-export') ||
          response.url().endsWith('/local-functions/team-finance-export')) &&
        response.request().method() === 'POST'
    );
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
    await page.getByRole('button', { name: /^(Експорт Excel|Export Excel)$/ }).click();
    const response = await responsePromise;
    console.log(`Export endpoint HTTP ${response.status()}`);
    assert.equal(response.status(), 200, 'Local Edge export runtime must succeed');
    assert.equal(response.headers()['access-control-allow-origin'], 'http://127.0.0.1:5175');
    assert.match(response.headers()['content-type'], /spreadsheetml/);
    assert.match(response.headers()['cache-control'], /private.*no-store/);
    const download = await downloadPromise;
    assert.ok(download, 'The browser must actually download the workbook');
    assert.equal(await download.failure(), null);
    assert.match(download.suggestedFilename(), /^finance-.*\.xlsx$/);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const downloadedBytes = Buffer.concat(chunks);
    assert.equal(downloadedBytes.subarray(0, 4).toString('hex'), '504b0304');
    console.log({ browserDownloadBytes: downloadedBytes.length });
    console.log('PASS: real browser export response is a private, authorized XLSX');
  }
  verified = true;
} finally {
  if (browser) await browser.close();
  if (team && verified && process.env.FINANCE_KEEP_FIXTURE === '1') {
    console.log(
      `Retained synthetic LOCAL beta preview: http://127.0.0.1:5175/team/${team}/accounts`
    );
  } else if (team) {
    await db.query('delete from public.teams where id=$1', [team]);
    console.log('Removed only the temporary local finance validation workspace.');
  }
  await db.end();
}
