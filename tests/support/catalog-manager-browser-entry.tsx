/** Test-only standalone benchmark entry. It never mounts the product router or
 * AuthProvider and is NOT semantic beta authentication/entitlement acceptance. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthContextValue } from '../../apps/web/src/auth/AuthContext';
import type { User } from '@supabase/supabase-js';
import '../../apps/web/src/styles/index.css';
import { setPrivateCacheScope } from '../../apps/web/src/team/private-cache-scope';
import { createCatalogManagerPerformanceHarness } from './catalog-manager-performance-harness';
import {
  CATALOG_PERFORMANCE_ACTOR,
  CATALOG_PERFORMANCE_TEAM
} from '../fixtures/catalog-manager-performance';
const size = Number(new URL(location.href).searchParams.get('size') ?? '0');
const harness = createCatalogManagerPerformanceHarness(size, 'atomic');
const reject = async (): Promise<never> => {
  throw Error('A26 synthetic authentication is read-only');
};
const user: User = {
  id: CATALOG_PERFORMANCE_ACTOR,
  aud: 'authenticated',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-11-02T10:00:00Z'
};
const auth: AuthContextValue = {
  status: 'authenticated',
  user,
  session: null,
  profile: null,
  isAdmin: false,
  error: null,
  loading: false,
  signInWithGoogle: reject,
  signInWithBetaFixture: reject,
  completeOAuthCallback: reject,
  adoptHandedOverSession: reject,
  signOut: reject,
  updateProfile: reject,
  refreshProfile: reject
};
// Freeze autonomous fixture polls/countdowns, not input, React, RAF or paint.
// This document is a separate, throwaway local benchmark origin.
let interval = 0;
const intervals = new Set<number>();
Object.defineProperty(window, 'setInterval', {
  configurable: true,
  value: () => {
    const id = ++interval;
    intervals.add(id);
    return id;
  }
});
Object.defineProperty(window, 'clearInterval', {
  configurable: true,
  value: (id?: number) => {
    if (id !== undefined) intervals.delete(id);
  }
});
localStorage.setItem('wishly.active-team.v1', CATALOG_PERFORMANCE_TEAM);
localStorage.setItem('language', 'en');
localStorage.setItem('catalog-icon-legend-seen', '1');
setPrivateCacheScope(CATALOG_PERFORMANCE_ACTOR, 'owner');
const allIds = new Set(harness.fixture.rows.map(row => row.catalogId)),
  halfIds = new Set(
    harness.fixture.rows.filter(row => row.name.includes('льон')).map(row => row.catalogId)
  );
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('tr[data-catalog-id]'));
let armed: {
  id: string;
  action: string;
  expected: unknown;
  start: number | null;
  stateReady: number | null;
  boundary: number | null;
  inputEvent?: string;
} | null = null;
let mutations = 0;
new MutationObserver(records => {
  mutations += records.length;
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true
});
for (const eventName of ['input', 'pointerup', 'click'])
  document.addEventListener(
    eventName,
    event => {
      if (!armed || armed.start !== null) return;
      const target = event.target instanceof Element ? event.target : null;
      const expected =
        armed.action === 'search'
          ? eventName === 'input' && target?.matches('input[type="search"]')
          : eventName === 'pointerup' || eventName === 'click';
      if (expected) {
        armed.inputEvent = event.type;
        armed.start = performance.now();
        performance.mark(`a26:${armed.id}:input`);
      }
    },
    true
  );
function stateMatches(action: string, expected: unknown) {
  if (action === 'cold') return window.__a26.ready();
  if (action === 'search') {
    const query = document.querySelector<HTMLInputElement>('input[type=search]')?.value ?? '';
    const ids = query === 'льон' ? halfIds : query === '' ? allIds : new Set<string>();
    const visible = rows();
    if (
      ids.size !== expected ||
      visible.length !== Math.min(Number(expected), 60) ||
      visible.some(row => !ids.has(row.dataset.catalogId ?? ''))
    )
      return false;
    const more = Array.from(document.querySelectorAll('button')).find(
      button =>
        button.textContent?.trim() === `Show more (${Number(expected) - visible.length} remaining)`
    );
    if (Number(expected) > visible.length && !more) return false;
    const clear = document.querySelector('button[aria-label="Clear search"]');
    return Boolean(clear) === Boolean(query) && !document.querySelector('.team-updater-detail');
  }
  if (action === 'selection') {
    const box = document.querySelector<HTMLElement>('.team-updater-select-all');
    const input = box?.querySelector<HTMLInputElement>('input[type=checkbox]');
    const checked = input
      ? input.checked
      : box?.querySelector('[role=checkbox]')?.getAttribute('aria-checked') === 'true';
    if (checked !== expected) return false;
    const footer = document.querySelector('.team-updater-footer');
    return expected ? Boolean(footer?.textContent?.includes(`${size} catalogs selected`)) : !footer;
  }
  if (action === 'details')
    return Boolean(document.querySelector('.team-updater-detail')) === expected;
  return false;
}
function observePaintBoundary(active: NonNullable<typeof armed>) {
  const deadline = performance.now() + 15000;
  const check = () => {
    if (armed !== active) return;
    if (performance.now() > deadline) return;
    if (active.start === null || !stateMatches(active.action, active.expected)) {
      requestAnimationFrame(check);
      return;
    }
    active.stateReady = performance.now();
    performance.mark(`a26:${active.id}:state`);
    requestAnimationFrame(() => {
      if (armed !== active) return;
      active.boundary = performance.now();
      performance.mark(`a26:${active.id}:boundary`);
    });
  };
  requestAnimationFrame(check);
}
window.__a26 = {
  fixture: {
    size,
    seed: harness.fixture.seed,
    halfMatchCount: harness.fixture.halfMatchCount,
    targetId: harness.fixture.rows[0]?.catalogId ?? null,
    targetName: harness.fixture.rows[0]?.name ?? null
  },
  ready: () =>
    !document.body.textContent?.includes('Loading catalogs…') &&
    harness.counts.managerReads === 1 &&
    rows().length === Math.min(size, 60),
  metrics: () => ({
    ...harness.snapshotCounts(),
    commits: harness.counts.profilerObserved ? harness.counts.commits : null,
    domRows: rows().length,
    domMutations: mutations,
    frozenIntervals: intervals.size
  }),
  arm(id: string, action: string, expected: unknown) {
    armed = { id, action, expected, start: null, stateReady: null, boundary: null };
    observePaintBoundary(armed);
  },
  async finish(action: string, expected: unknown) {
    const active = armed;
    if (!active) throw Error('No armed sample');
    const deadline = performance.now() + 15000;
    while (active.boundary === null) {
      if (performance.now() > deadline) throw Error('Required DOM/RAF boundary not observed');
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    if (active.start === null || !stateMatches(action, expected))
      throw Error('Missing input start or changed DOM state');
    return { ...active, expected, domVerified: true, metrics: window.__a26.metrics() };
  },
  matches: stateMatches
};
const coldId = new URL(location.href).searchParams.get('sample') ?? 'cold';
armed = {
  id: coldId,
  action: 'cold',
  expected: size,
  start: performance.now(),
  stateReady: null,
  boundary: null,
  inputEvent: 'entry_before_createRoot'
};
performance.mark(`a26:${coldId}:input`);
observePaintBoundary(armed);
createRoot(document.getElementById('root')!).render(<harness.Harness auth={auth} />);
export interface A26Controller {
  fixture: {
    size: number;
    seed: number;
    halfMatchCount: number;
    targetId: string | null;
    targetName: string | null;
  };
  ready(): boolean;
  metrics(): Record<string, unknown>;
  arm(id: string, action: string, expected: unknown): void;
  finish(action: string, expected: unknown): Promise<Record<string, unknown>>;
  matches(action: string, expected: unknown): boolean;
}
declare global {
  interface Window {
    __a26: A26Controller;
  }
}
