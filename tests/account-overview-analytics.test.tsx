// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAccounts, type AccountsClient } from '../apps/web/src/team/accounts/useAccounts';
import { analytics } from '../apps/web/src/analytics/service';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('returns null and never proves display for a failed authoritative refresh', async () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
  const list = vi.fn().mockResolvedValue([]);
  const client = { listAccounts: list } as unknown as AccountsClient;
  const view = renderHook(() => useAccounts({ teamId: 'overview-test', client }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  track.mockClear();
  list.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' }));
  let result: unknown;
  await act(async () => {
    result = await view.result.current.refetch();
  });
  expect(result).toBeNull();
  expect(track).toHaveBeenCalledWith(
    'team_account_terminal',
    expect.objectContaining({
      account_action: 'overview',
      account_stage: 'terminal',
      account_code: 'PERMISSION_DENIED',
      account_result: 'failed'
    })
  );
  expect(track.mock.calls.some(([event]) => event === 'team_account_visible')).toBe(false);
  expect(view.result.current.error).toBe('denied');
});

it('returns the canonical account list and proves only that committed account part', async () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
  const client = { listAccounts: vi.fn().mockResolvedValue([]) } as unknown as AccountsClient;
  const view = renderHook(() => useAccounts({ teamId: 'overview-test', client }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  track.mockClear();
  let result: unknown;
  await act(async () => {
    result = await view.result.current.refetch();
  });
  expect(result).toEqual([]);
  expect(track).toHaveBeenCalledWith(
    'team_account_visible',
    expect.objectContaining({
      account_action: 'overview',
      account_stage: 'applied',
      account_result: 'partial',
      account_coverage: 'accounts_only'
    })
  );
  expect(
    track.mock.calls.some(
      ([, properties]) =>
        properties && 'account_coverage' in properties && properties.account_coverage === 'complete'
    )
  ).toBe(false);
});
