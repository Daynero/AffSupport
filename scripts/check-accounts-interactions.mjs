#!/usr/bin/env node
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * 038 real-browser acceptance for long press, scope-aware keyboard pickup,
 * temporary social folding, Escape and click suppression. Every drag is
 * cancelled: this runner must issue zero reorder mutations.
 *
 * Requires an editable local beta fixture with >=2 socials, >=2 РК per open
 * social and >=1 initially collapsed social. Fails on insufficient evidence.
 * Usage: node scripts/check-accounts-interactions.mjs [teamId] [--site=http://127.0.0.1:5175]
 *        [--storage-state=/path/to/local-auth.json] [--require-stress]
 * --require-stress additionally requires 50 socials / 500 source РК before
 * folding and gates sampled drag rAF p95 <=20ms and max <=50ms. Ordinary beta
 * measurements are printed as observations and never called scale proof.
 */
import assert from 'node:assert/strict';
import { openAccountsBrowser } from './lib/accounts-browser.mjs';

const requireStress = process.argv.includes('--require-stress');
const { browser, page } = await openAccountsBrowser();
const reorderWrites = [];
page.on('request', request => {
  if (request.url().includes('/rpc/reorder_team_accounts')) reorderWrites.push(request.method());
});
// Default Feedback lifts the complete original source; there is no custom overlay.
const overlay = page.locator('[data-dnd-dragging]');
const groups = page.locator('.team-account[data-account-id]');
const rowSelector = '.team-agent-row[data-reorder-id]';
const state = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.team-account[data-account-id]')].map(group => ({
      id: group.getAttribute('data-account-id'),
      collapsed: group.classList.contains('is-collapsed'),
      children: (group.getAttribute('data-account-member-order') ?? '').split(',').filter(Boolean)
    }))
  );
async function safePoint(locator) {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    for (let y = box.top + 6; y < box.bottom - 4; y += 8) {
      for (let x = box.left + 6; x < Math.min(box.right - 4, innerWidth - 4); x += 12) {
        const hit = document.elementFromPoint(x, y);
        if (
          hit &&
          hit.closest('[data-reorder-id]') === element &&
          !hit.closest('button,input,textarea,select,a,[contenteditable="true"]')
        )
          return { x, y };
      }
    }
    throw new Error('No visible non-interactive long-press surface in fixture');
  });
}
async function waitForOverlay(visible) {
  await overlay.waitFor({ state: visible ? 'visible' : 'detached', timeout: 3000 });
}
try {
  assert.ok((await groups.count()) >= 2, 'Need at least two social groups');
  // Establish a mixed fold state without relying on remembered fixture state.
  const firstToggle = groups.nth(0).locator('.team-account-toggle');
  const secondToggle = groups.nth(1).locator('.team-account-toggle');
  if ((await firstToggle.getAttribute('aria-expanded')) !== 'true') await firstToggle.click();
  if ((await secondToggle.getAttribute('aria-expanded')) === 'true') await secondToggle.click();
  const before = await state();
  const socialCount = before.length;
  const rkCount = before.reduce((total, group) => total + group.children.length, 0);
  const renderedRkCount = await page.locator(rowSelector).count();
  assert.ok(
    before.some(group => group.collapsed) && before.some(group => !group.collapsed),
    'Mixed fold fixture required'
  );
  assert.ok(
    (await groups.first().locator(rowSelector).count()) >= 2,
    'Need two rendered РК in first social'
  );
  if (requireStress)
    assert.ok(
      socialCount >= 50 && rkCount >= 500,
      'Stress proof needs >=50 socials and >=500 loaded source РК, including deferred rows'
    );
  console.log(
    JSON.stringify({
      socialCount,
      sourceRkCount: rkCount,
      renderedRkCount,
      deferredRendering: renderedRkCount < rkCount
    })
  );

  const socialHeader = groups.first().locator('.team-account-head[data-reorder-id]');
  const point = await safePoint(socialHeader);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForTimeout(200);
  assert.equal(await overlay.count(), 0, 'A short press must not capture');
  // Leave the header as a real scroll/drag gesture would. Releasing over the
  // original header can still legitimately generate a normal fold click.
  const headerBox = await socialHeader.boundingBox();
  assert.ok(headerBox, 'Header must remain visible');
  await page.mouse.move(point.x + 10, headerBox.y + headerBox.height + 40, { steps: 3 });
  await page.mouse.up();
  assert.deepEqual(await state(), before, 'Pre-capture cancellation changed order or fold state');
  console.log('PASS short press and pre-capture movement cancellation');

  const capturedPoint = await safePoint(socialHeader);
  await page.mouse.move(capturedPoint.x, capturedPoint.y);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await waitForOverlay(true);
  assert.ok(
    (await state()).every(group => group.collapsed),
    'All socials must temporarily fold during social drag'
  );
  await page.evaluate(() => {
    globalThis.__accountFrameProbe = { times: [], last: performance.now(), running: true };
    const frame = now => {
      const probe = globalThis.__accountFrameProbe;
      if (!probe.running) return;
      probe.times.push(now - probe.last);
      probe.last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.mouse.move(capturedPoint.x + 32, capturedPoint.y + 110, { steps: 24 });
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await waitForOverlay(false);
  await page.waitForTimeout(400);
  assert.deepEqual(await state(), before, 'Escape must restore exact mixed fold state and order');
  const samples = await page.evaluate(() => {
    const probe = globalThis.__accountFrameProbe;
    probe.running = false;
    return probe.times.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  });
  const p95 = samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? null;
  const max = samples.at(-1) ?? null;
  console.log(
    JSON.stringify({
      check: 'social-hold-fold-Escape',
      socialCount,
      rkCount,
      samples: samples.length,
      frame_p95_ms: p95,
      frame_max_ms: max,
      stressProofRequested: requireStress
    })
  );
  if (requireStress) {
    assert.ok(samples.length >= 20, 'Need >=20 moving-frame samples');
    assert.ok(p95 !== null && p95 <= 20 && max !== null && max <= 50, 'Drag frame budget exceeded');
  }

  const firstRow = groups.first().locator(rowSelector).first();
  const rowPoint = await safePoint(firstRow);
  await page.mouse.move(rowPoint.x, rowPoint.y);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await waitForOverlay(true);
  assert.equal((await state())[0].collapsed, false, 'Dragging an РК must not fold its social');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await waitForOverlay(false);
  assert.deepEqual(await state(), before, 'Cancelling РК drag changed membership/order');
  console.log('PASS РК hold capture and Escape without social folding');

  const keyboardHandle = firstRow.locator('[data-reorder-keyboard]');
  await keyboardHandle.focus();
  await page.keyboard.press('Space');
  await waitForOverlay(true);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await waitForOverlay(false);
  assert.deepEqual(await state(), before, 'Keyboard cancellation changed membership/order');
  assert.equal(
    await keyboardHandle.evaluate(element => document.activeElement === element),
    true,
    'Keyboard cancellation must retain focus'
  );
  assert.equal(reorderWrites.length, 0, 'Cancelled gestures must not write persisted order');
  console.log('PASS keyboard pickup/move/cancel, focus and zero persisted reorder writes');
  console.log(
    'Not covered: successful persisted drop, touch-device scroll, finance edits, archive, 500-row performance unless --require-stress passes.'
  );
} finally {
  await browser.close();
}
