// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * next 2026-11-17: after a deploy the host answered the app's stylesheet with its HTML, the
 * browser kept that answer, and Soty ran unstyled with nothing noticing — the boot recovery
 * only looked for a page that never hydrated, and only refetched modules.
 */
const html = readFileSync('apps/web/index.html', 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
  .map(match => match[1]!)
  .find(code => code.includes('soty.boot-recovery.v1'))!;

let fetchMock: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
function boot(styled: boolean) {
  document.head.innerHTML =
    '<link rel="modulepreload" href="/assets/app.js"><link rel="stylesheet" href="/assets/index.css">';
  document.body.innerHTML = '<div id="root"><main>app</main></div>';
  const link = document.querySelector('link[rel="stylesheet"]')!;
  Object.defineProperty(link, 'sheet', { value: styled ? {} : null });
  new Function('location', script)({ reload, href: 'https://next.invalid/' });
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  fetchMock = vi.fn(() => Promise.resolve(new Response('')));
  vi.stubGlobal('fetch', fetchMock);
  reload = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('refetches a refused stylesheet past the cache and reloads once', async () => {
  boot(false);
  await vi.advanceTimersByTimeAsync(3500);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/assets/index.css'),
    expect.objectContaining({ cache: 'reload' })
  );
  expect(reload).toHaveBeenCalledTimes(1);
  expect(document.querySelector('#root main')?.textContent).toBe('app');

  // Still refused after that reload: leave the running app alone rather than loop.
  reload.mockClear();
  boot(false);
  await vi.advanceTimersByTimeAsync(6000);
  expect(reload).not.toHaveBeenCalled();
  expect(document.querySelector('#root main')?.textContent).toBe('app');
});

it('does nothing to a styled, hydrated page', async () => {
  boot(true);
  await vi.advanceTimersByTimeAsync(6000);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
