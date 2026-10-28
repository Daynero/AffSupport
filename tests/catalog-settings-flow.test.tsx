// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const track = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track } }));
import { useCatalogSettingsFlow } from '../apps/web/src/team/product-catalog/useCatalogSettingsFlow';
afterEach(() => {
  cleanup();
  track.mockClear();
});

it('reports delivery only after commit and ignores a superseded read reply', () => {
  const { result, unmount } = renderHook(() => useCatalogSettingsFlow());
  let old = '';
  let current = '';
  act(() => {
    old = result.current.start();
    current = result.current.start();
    result.current.confirm(old);
  });
  expect(track.mock.calls.filter(([event]) => event === 'operation_completed')).toHaveLength(0);
  act(() => {
    result.current.stage('save_confirmed', current);
    result.current.confirm(current);
    expect(track.mock.calls.filter(([event]) => event === 'operation_completed')).toHaveLength(0);
  });
  expect(track.mock.calls.filter(([event]) => event === 'operation_completed')).toHaveLength(1);
  expect(track.mock.calls.at(-1)?.[1]).toMatchObject({
    attempt_id: current,
    action_identifier: 'result_visible'
  });
  unmount();
  expect(track.mock.calls.filter(([event]) => event === 'operation_cancelled')).toHaveLength(1);
});

it('cancels unfinished work and never converts failure into visible success', () => {
  const { result, unmount } = renderHook(() => useCatalogSettingsFlow());
  act(() => {
    const attempt = result.current.start();
    result.current.fail('READ_FAILED', attempt);
    result.current.confirm(attempt);
  });
  expect(track.mock.calls.filter(([event]) => event === 'operation_completed')).toHaveLength(0);
  act(() => {
    result.current.start();
  });
  unmount();
  expect(track.mock.calls.at(-1)?.[0]).toBe('operation_cancelled');
});
