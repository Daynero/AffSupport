// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { launchFailure } from '../supabase/functions/_shared/launch-failures';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import { useLaunchDraft } from '../apps/web/src/team/launches/useLaunchDraft';
import { launchConfig } from './fixtures/launches';
import type { LaunchDetail } from '../packages/shared/src/team/launches';
import { ProductAnalytics, type PendingAnalyticsEvent } from '../apps/web/src/analytics/service';
import {
  launchAction,
  launchMutation,
  launchVisible
} from '../apps/web/src/team/launches/analytics';

it('strips inherited provider details even when a short value passes the generic detail sanitizer', () => {
  const error = new TeamFunctionError('DRIVE_UNAVAILABLE', {
    retryable: true,
    details: { reason: 'tinyPrivateSecret' }
  });
  expect(error.details).toEqual({ reason: 'tinyPrivateSecret' });
  const safe = launchFailure(error);
  expect(safe.code).toBe('DRIVE_UNAVAILABLE');
  expect(safe.retryable).toBe(true);
  expect(safe.status).toBe(error.status);
  expect(JSON.stringify(safe)).not.toContain('tinyPrivateSecret');
});
it('maps arbitrary exception content to a closed cause without logging it', () => {
  const safe = launchFailure(new Error('https://example.invalid?token=SYNTHETIC_SECRET'));
  expect(safe.code).toBe('LAUNCH_INTERNAL_ERROR');
  expect(safe.details).toEqual({ reason: 'UNKNOWN_CAUSE' });
  expect(JSON.stringify(safe)).not.toContain('SYNTHETIC_SECRET');
});

it('keeps an unsaved URL only in the mounted draft hook', () => {
  const secret = 'https://example.invalid/?capi=SYNTHETIC_SECRET';
  localStorage.clear();
  sessionStorage.clear();
  const draft = renderHook(() => useLaunchDraft(null));
  act(() => draft.result.current.setConfig(current => ({ ...current, originalUrl: secret })));
  expect(draft.result.current.config.originalUrl).toBe(secret);
  draft.unmount();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it('does not write an unsaved URL to browser persistence during edit, discard, or remount', () => {
  const secret = 'SYNTHETIC_CAPI_STORAGE_SENTINEL';
  const url = `https://example.invalid/?capi=${secret}`;
  localStorage.clear();
  sessionStorage.clear();
  const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
  const indexedOpen = vi.fn(() => {
    throw new Error('Launch draft attempted to open IndexedDB');
  });
  const cacheOpen = vi.fn(() => {
    throw new Error('Launch draft attempted to open Cache API');
  });
  vi.stubGlobal('indexedDB', { open: indexedOpen });
  vi.stubGlobal('caches', { open: cacheOpen });
  try {
    const draft = renderHook(() => useLaunchDraft(null));
    act(() => draft.result.current.setConfig(current => ({ ...current, originalUrl: url })));
    expect(draft.result.current.config.originalUrl).toBe(url);
    draft.unmount();
    const reopened = renderHook(() => useLaunchDraft(null));
    expect(reopened.result.current.config.originalUrl).toBeUndefined();
    reopened.unmount();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(indexedOpen).not.toHaveBeenCalled();
    expect(cacheOpen).not.toHaveBeenCalled();
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(secret);
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(secret);
  } finally {
    storageWrite.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('clears a protected draft from mounted React state when its detail is revoked', () => {
  const secret = 'SYNTHETIC_REVOKED_URL_SENTINEL';
  const detail = {
    id: 'launch',
    version: '1',
    draft: launchConfig({ originalUrl: `https://example.invalid/?capi=${secret}` }),
    expectedSourceSnapshot: null,
    assigneeId: null,
    workStatus: 'todo',
    activeRevision: null,
    generation: null
  } satisfies LaunchDetail;
  const draft = renderHook(({ current }) => useLaunchDraft(current), {
    initialProps: { current: detail as LaunchDetail | null }
  });
  expect(JSON.stringify(draft.result.current.config)).toContain(secret);
  act(() =>
    draft.result.current.setConfig(current => ({
      ...current,
      originalUrl: 'https://example.invalid/?capi=SYNTHETIC_UNSAVED_SENTINEL'
    }))
  );
  draft.rerender({ current: null });
  expect(JSON.stringify(draft.result.current.config)).not.toContain(secret);
  expect(JSON.stringify(draft.result.current.config)).not.toContain('SYNTHETIC_UNSAVED_SENTINEL');
  expect(draft.result.current.sources).toBeNull();
  draft.unmount();
});

it('keeps synthetic URL and error content out of the persisted and delivered analytics queue', async () => {
  const secret = 'SYNTHETIC_LAUNCH_PRIVACY_QUEUE_SECRET';
  const actor = '77000000-0000-4000-8000-000000000001';
  const launchId = '77000000-0000-4000-8000-000000000002';
  const flowId = '77000000-0000-4000-8000-000000000003';
  const delivered: PendingAnalyticsEvent[] = [];
  localStorage.clear();
  const analytics = new ProductAnalytics(async events => {
    delivered.push(...events);
    return { acceptedEventIds: events.map(event => event.event_id) };
  }, localStorage);
  analytics.setUser(actor);
  const result = { originalUrl: `https://example.invalid/?capi=${secret}` };
  expect(
    await launchMutation({ flowId, launchId }, 'save_draft', async () => result, analytics)
  ).toBe(result);
  launchAction({ flowId, launchId }, 'generate', 'failure', secret, undefined, analytics);
  launchVisible({ launchId }, analytics);
  expect(analytics.pendingCount()).toBeGreaterThan(0);
  expect(JSON.stringify(Object.entries(localStorage))).not.toContain(secret);
  await analytics.flush();
  expect(delivered.length).toBeGreaterThan(0);
  expect(JSON.stringify(delivered)).not.toContain(secret);
  expect(delivered.some(event => event.properties.launch_code === 'UNKNOWN')).toBe(true);
  analytics.setUser(null);
  expect(analytics.pendingCount()).toBe(0);
  expect(JSON.stringify(Object.entries(localStorage))).not.toContain(secret);
  localStorage.clear();
});
