// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { fallbackSpaceAccess, useSpaceAccess } from '../apps/web/src/team/tariffs/useSpaceAccess';

afterEach(() => cleanup());

it('uses the legacy authority only when there is no authoritative access reply yet', async () => {
  const client = {
    getMySpaceAccess: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
    canAccessTeamWorkspace: vi.fn().mockResolvedValue(true)
  };
  const view = renderHook(() => useSpaceAccess({ client, enabled: true, poll: false }));
  await waitFor(() => expect(view.result.current.status).toBe('ready'));
  expect(view.result.current.access?.mode).toBe('workspace');
  expect(client.canAccessTeamWorkspace).toHaveBeenCalledOnce();
  await act(async () => view.result.current.recheck());
  expect(client.canAccessTeamWorkspace).toHaveBeenCalledOnce();
  expect(view.result.current.access?.mode).toBe('workspace');
});

it.each([false, true])(
  'fails closed when the initial RPC and optional legacy fallback fail (legacy=%s)',
  async legacy => {
    const client = {
      getMySpaceAccess: vi.fn().mockRejectedValue(new Error('unavailable')),
      ...(legacy
        ? { canAccessTeamWorkspace: vi.fn().mockRejectedValue(new Error('unavailable')) }
        : {})
    };
    const view = renderHook(() => useSpaceAccess({ client, enabled: true, poll: false }));
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(view.result.current.access?.mode).toBe('showcase');
  }
);

it('retains a confirmed denial during an outage rather than upgrading through the legacy fallback', async () => {
  const denied = fallbackSpaceAccess(false);
  const client = {
    getMySpaceAccess: vi.fn().mockResolvedValueOnce(denied).mockRejectedValue(new Error('outage')),
    canAccessTeamWorkspace: vi.fn().mockResolvedValue(true)
  };
  const view = renderHook(() => useSpaceAccess({ client, enabled: true, poll: false }));
  await waitFor(() => expect(view.result.current.access).toEqual(denied));
  await act(async () => view.result.current.recheck());
  expect(view.result.current.access).toEqual(denied);
  expect(client.canAccessTeamWorkspace).not.toHaveBeenCalled();
});
