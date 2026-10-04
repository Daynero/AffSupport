// Isolated UI check only: real local beta auth, synthetic read-only finance DTO.
// This is not a substitute for the full account-space end-to-end workflow.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({
  executablePath:
    process.env.FINANCE_CHROMIUM_PATH ||
    '/Users/daynero/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  headless: true
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.route('**/rest/v1/rpc/get_team_agent_finance', async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      json: {
        schemaVersion: 1,
        teamId: body.p_team,
        teamName: 'Перевірка',
        from: body.p_from,
        to: body.p_to,
        currency: 'USD',
        generatedAt: new Date().toISOString(),
        accounts: [{ id: 'x', name: 'Довга назва соціального акаунта для перевірки інтерфейсу' }],
        agents: Array.from({ length: 12 }, (_, index) => ({
          id: index ? `a${index}` : 'a',
          agentId: index
            ? `00123456789012345${String(index).padStart(3, '0')}`
            : '00123456789012345678'
        })),
        placements: [
          {
            id: 'p',
            agentRowId: 'a',
            accountId: 'x',
            startsOn: '2026-01-01',
            endsOn: null,
            version: '1'
          }
        ].concat(
          Array.from({ length: 11 }, (_, index) => ({
            id: `p${index + 1}`,
            agentRowId: `a${index + 1}`,
            accountId: 'x',
            startsOn: '2026-01-01',
            endsOn: null,
            version: '1'
          }))
        ),
        fields: ['balance', 'topup', 'spend'].map(metric => ({
          agentRowId: 'a',
          date: body.p_from,
          metric,
          value: '999999999.99',
          currency: 'USD',
          version: '1',
          placementId: 'p',
          updatedAt: new Date().toISOString(),
          updatedBy: null
        }))
      }
    });
  });
  await page.goto('http://127.0.0.1:5175/login');
  await page.getByRole('button', { name: /beta/i }).click();
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const source = '/src/team/accounts/finance/FinanceWorkspace.tsx';
    // Use Vite's exact dependency URL, including its HMR stamp, so contexts
    // are not accidentally instantiated twice by this isolated harness.
    const code = await (await fetch(source)).text();
    const toastUrl = code.match(/import \{ useToasts \} from "([^"]+)"/)[1];
    const { FinanceWorkspace } = await import(source);
    const { ToastProvider } = await import(toastUrl);
    document.getElementById('root').style.display = 'none';
    const host = document.createElement('main');
    host.className = 'team-panel';
    document.body.append(host);
    ReactDOM.createRoot(host).render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(FinanceWorkspace, {
          teamId: '22222222-2222-4222-8222-222222222222',
          canEdit: true,
          revision: 0
        })
      )
    );
  });
  await page.locator('input[inputmode="decimal"]').first().waitFor();
  console.log(
    await page.getByRole('searchbox').evaluate(input => {
      const group = input.parentElement;
      return {
        searchEnabled: !input.disabled,
        groupClass: group.className,
        background: getComputedStyle(group).backgroundColor,
        before: getComputedStyle(group, '::before').backgroundColor,
        after: getComputedStyle(group, '::after').backgroundColor
      };
    })
  );
  for (const width of [320, 390, 768, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: fileURLToPath(new URL(`finance-${width}.png`, import.meta.url)),
      fullPage: true
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    console.log(JSON.stringify({ width, overflow }));
    if (overflow > 0) throw new Error(`Page overflow at ${width}px: ${overflow}`);
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole('button', { name: /^(This month|Цей місяць)$/ }).click();
    await page.getByRole('table').waitFor();
    const grid = await page.locator('.finance-matrix-scroll').evaluate(region => {
      region.scrollLeft = region.scrollWidth;
      region.scrollTop = 100;
      const rows = [...region.querySelectorAll('[role="row"]')];
      return rows.every(row => {
        const last = row.lastElementChild.getBoundingClientRect();
        return last.right <= row.getBoundingClientRect().right + 1;
      });
    });
    if (!grid)
      throw new Error('New/empty agent columns extend beyond row borders and sticky backgrounds');
    await page.screenshot({
      path: fileURLToPath(new URL(`finance-month-${theme}-390.png`, import.meta.url)),
      fullPage: true
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    console.log(JSON.stringify({ mode: 'month', theme, width: 390, overflow }));
    if (overflow > 0) throw new Error(`Monthly page overflow: ${overflow}`);
    await page.getByRole('button', { name: /^(Today|Сьогодні)$/ }).click();
    await page.locator('input[inputmode="decimal"]').first().waitFor();
    await page.screenshot({
      path: fileURLToPath(new URL(`finance-day-${theme}-390.png`, import.meta.url)),
      fullPage: true
    });
  }
} finally {
  await browser.close();
}
