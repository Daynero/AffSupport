#!/usr/bin/env node
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * 038 unified Accounts: the TABLE owns vertical scrolling. Compact variable-height rows
 * are expected when runs wrap; every complete run line must fit its own cell.
 * Only the local beta is supported. No database writes or DOM fixture cloning.
 * Usage: node scripts/check-accounts-layout.mjs [teamId] [--site=http://127.0.0.1:5175]
 *        [--storage-state=/path/to/local-auth.json]
 */
import { openAccountsBrowser } from './lib/accounts-browser.mjs';
const WIDTHS = [
  320, 360, 390, 414, 480, 560, 561, 700, 900, 1000, 1001, 1100, 1200, 1201, 1280, 1440, 1600
];
const { browser, page } = await openAccountsBrowser();
const failures = [];
try {
  const viewports = WIDTHS.flatMap(width => [
    { width, height: 900 },
    { width, height: 650 }
  ]);
  for (const { width, height } of viewports) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const seen = await page.evaluate(() => {
      const table = document.querySelector('.team-accounts-table');
      if (!(table instanceof HTMLElement)) throw new Error('Unified table missing');
      const style = getComputedStyle(table);
      const rect = table.getBoundingClientRect();
      const rows = [...table.querySelectorAll('.team-agent-row')];
      // Cells stay inside their row and never cover one another. Wide layouts
      // also share one baseline; narrow layouts intentionally use several rows.
      const misalignedRows = rows
        .filter(row => !row.classList.contains('is-editing'))
        .flatMap(row => {
          const cells = [...row.children].filter(cell =>
            cell.matches(
              '.team-agent-id, .team-agent-status, .team-agent-runs, .unified-agent-finance, .team-agent-actions'
            )
          );
          const bounds = row.getBoundingClientRect();
          const boxes = cells
            .map(cell => cell.getBoundingClientRect())
            .filter(box => box.height > 0);
          const outside = boxes.some(
            box =>
              box.left < bounds.left - 1 ||
              box.right > bounds.right + 1 ||
              box.top < bounds.top - 1 ||
              box.bottom > bounds.bottom + 1
          );
          const overlap = boxes.some((box, i) =>
            boxes
              .slice(i + 1)
              .some(
                other =>
                  Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1 &&
                  Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1
              )
          );
          const centers = boxes.map(box => (box.top + box.bottom) / 2);
          const spread = Math.max(...centers) - Math.min(...centers);
          return outside || overlap || (innerWidth > 1000 && spread > 2)
            ? [{ id: row.getAttribute('data-agent-row-id'), spread, outside, overlap }]
            : [];
        });
      const blockedSocialActions = [
        ...table.querySelectorAll('.team-account-head:not(.is-editing)')
      ]
        .filter(head => {
          const title = head.querySelector('.team-account-title')?.getBoundingClientRect();
          const actions = head.querySelector('.team-account-actions')?.getBoundingClientRect();
          return (
            title &&
            actions &&
            Math.min(title.right, actions.right) - Math.max(title.left, actions.left) > 1 &&
            Math.min(title.bottom, actions.bottom) - Math.max(title.top, actions.top) > 1
          );
        })
        .map(head => head.getAttribute('data-reorder-id'));
      const runLines = [...table.querySelectorAll('.team-agent-run:not(.is-empty)')];
      const escapedRunControls = runLines.flatMap(line => {
        const bounds = line.getBoundingClientRect();
        return [...line.querySelectorAll('button')]
          .filter(button => {
            const box = button.getBoundingClientRect();
            return (
              box.left < bounds.left - 1 ||
              box.right > bounds.right + 1 ||
              box.top < bounds.top - 1 ||
              box.bottom > bounds.bottom + 1
            );
          })
          .map(button => button.getAttribute('aria-label'));
      });
      const spill = runLines
        .map(line => ({
          width: line.getBoundingClientRect().width,
          excess: line.scrollWidth - line.clientWidth,
          cellExcess:
            line.getBoundingClientRect().right -
            (line.parentElement?.getBoundingClientRect().right ?? Number.NEGATIVE_INFINITY)
        }))
        .filter(line => line.excess > 1 || line.cellExcess > 1);
      const toolbar = document.querySelector('.team-accounts-sticky')?.getBoundingClientRect();
      const toolbarOverlapsTable = !toolbar || toolbar.bottom > rect.top + 1;
      const tableBelowViewport = rect.bottom > innerHeight + 1;
      const before = { x: table.scrollLeft, y: table.scrollTop };
      table.scrollLeft = table.scrollWidth;
      table.scrollTop = table.scrollHeight;
      const reachesRight = Math.abs(table.scrollWidth - table.clientWidth - table.scrollLeft) <= 2;
      const reachesBottom =
        Math.abs(table.scrollHeight - table.clientHeight - table.scrollTop) <= 2;
      table.scrollLeft = before.x;
      table.scrollTop = before.y;
      return {
        toolbarOverlapsTable,
        tableBelowViewport,
        rowCount: rows.length,
        runCount: runLines.length,
        rowHeights: [...new Set(rows.map(row => Math.round(row.getBoundingClientRect().height)))],
        spill,
        misalignedRows,
        blockedSocialActions,
        escapedRunControls,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tableOutsideViewport: rect.left < -1 || rect.right > innerWidth + 1,
        ownsScroll: style.overflowX === 'hidden' && ['auto', 'scroll'].includes(style.overflowY),
        innerHorizontalOverflow: table.scrollWidth > table.clientWidth + 1,
        innerVerticalOverflow: table.scrollHeight > table.clientHeight + 1,
        reachesRight,
        reachesBottom
      };
    });
    const ok =
      !seen.toolbarOverlapsTable &&
      !seen.tableBelowViewport &&
      seen.rowCount > 0 &&
      seen.runCount > 0 &&
      !seen.spill.length &&
      !seen.misalignedRows.length &&
      !seen.blockedSocialActions.length &&
      !seen.escapedRunControls.length &&
      seen.pageOverflow <= 1 &&
      !seen.tableOutsideViewport &&
      seen.ownsScroll &&
      !seen.innerHorizontalOverflow &&
      seen.reachesRight &&
      seen.reachesBottom;
    if (!ok) failures.push({ width, height, ...seen });
    console.log(JSON.stringify({ width, height, ok, ...seen }));
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(
    `Unified layout failed at widths: ${failures.map(failure => `${failure.width}×${failure.height}`).join(', ')}`
  );
  process.exitCode = 1;
} else {
  console.log(
    'PASS: variable-height run content fits; the unified table fits horizontally and owns reachable vertical overflow. This is layout evidence, not a 500-row performance result.'
  );
}
