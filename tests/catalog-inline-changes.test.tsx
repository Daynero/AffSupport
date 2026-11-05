// @vitest-environment jsdom
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatalogUpdateProfile } from '@video-compressor/shared';
import { TeamApiError, type CatalogRegistryRow } from '../apps/web/src/api/team';
import { useCatalogInlineChanges } from '../apps/web/src/team/catalog-updater/useCatalogInlineChanges';
import { analytics } from '../apps/web/src/analytics/service';
import { CatalogIconControls } from '../apps/web/src/team/catalog-updater/CatalogIconControls';
const profile: CatalogUpdateProfile = {
  catalogId: 'one',
  version: 1,
  updatedAt: '',
  restitch: false,
  randomLinkVariation: true,
  refreshImages: true,
  refreshTexts: true,
  growProducts: true
};
const row = { catalogId: 'one', profile, updateInterval: null } as CatalogRegistryRow;
beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup(patch = vi.fn().mockResolvedValue({ ...profile, restitch: true, version: 2 })) {
  const client = {
    getCatalogUpdater: vi.fn(),
    listTeamProductCatalogs: vi.fn().mockResolvedValue([row]),
    listCatalogUpdateProfiles: vi.fn().mockResolvedValue([profile]),
    patchCatalogUpdateProfile: patch
  };
  const hook = renderHook(() =>
    useCatalogInlineChanges({ teamId: 'team', client, rows: [row], reload: vi.fn() })
  );
  return { ...hook, client };
}
it('writes exactly one field and synchronously blocks a second mutation of the same catalog', async () => {
  let resolve!: (value: CatalogUpdateProfile) => void;
  const patch = vi.fn(
    () =>
      new Promise<CatalogUpdateProfile>(done => {
        resolve = done;
      })
  );
  const { result } = setup(patch);
  let first!: Promise<boolean>;
  act(() => {
    first = result.current.change('one', 'restitch', true);
    void result.current.change('one', 'refreshTexts', false);
  });
  expect(result.current.blocked('one')).toBe(true);
  expect(patch).toHaveBeenCalledTimes(1);
  expect(patch).toHaveBeenCalledWith('team', 'one', 1, { restitch: true });
  await act(async () => {
    resolve({ ...profile, restitch: true, version: 2 });
    await first;
  });
  expect(result.current.snapshotFor('one')?.profile.restitch).toBe(true);
  expect(result.current.undo[0]?.before).toBe(false);
  expect(result.current.blocked('one')).toBe(false);
});
it('reads back an uncertain response and never blindly sends the mutation again', async () => {
  const patch = vi.fn().mockRejectedValue(new TypeError('network'));
  const { result, client } = setup(patch);
  client.listCatalogUpdateProfiles.mockResolvedValue([{ ...profile, restitch: true, version: 2 }]);
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  expect(patch).toHaveBeenCalledTimes(1);
  expect(client.listCatalogUpdateProfiles).toHaveBeenCalledTimes(1);
  expect(result.current.states.one?.phase).toBe('saved');
  expect(result.current.snapshotFor('one')?.profile.version).toBe(2);
});
it('keeps an unknown write locked when readback also fails', async () => {
  const { result, client } = setup(vi.fn().mockRejectedValue(new TypeError('network')));
  client.listCatalogUpdateProfiles.mockRejectedValue(new TypeError('offline'));
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  expect(result.current.states.one?.phase).toBe('unknown');
  expect(result.current.blocked('one')).toBe(true);
});
it('does not clear an unknown write after reading its unchanged old version, and recovers its Undo after actual commit', async () => {
  const patch = vi.fn().mockRejectedValue(new TypeError('reply lost'));
  const { result, client } = setup(patch);
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  expect(result.current.states.one?.phase).toBe('unknown');
  await act(async () => {
    await result.current.reconcile('one');
  });
  expect(result.current.states.one?.phase).toBe('unknown');
  expect(result.current.blocked('one')).toBe(true);
  expect(patch).toHaveBeenCalledTimes(1);
  client.listCatalogUpdateProfiles.mockResolvedValue([{ ...profile, version: 2, restitch: true }]);
  await act(async () => {
    await result.current.reconcile('one');
  });
  expect(result.current.states.one?.phase).toBe('saved');
  expect(result.current.undo).toMatchObject([{ before: false, after: true, version: 2 }]);
  expect(patch).toHaveBeenCalledTimes(1);
});
it('blocks another write while the previous result is unknown', async () => {
  const patch = vi.fn().mockRejectedValue(new TypeError('reply lost'));
  const { result } = setup(patch);
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  await act(async () => {
    await result.current.change('one', 'refreshTexts', false);
  });
  expect(patch).toHaveBeenCalledTimes(1);
  expect(result.current.states.one?.phase).toBe('unknown');
});
it('rechecks an unknown Undo without sending the inverse twice', async () => {
  const { result, client } = setup();
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  client.listCatalogUpdateProfiles.mockResolvedValue([{ ...profile, restitch: true, version: 2 }]);
  client.patchCatalogUpdateProfile.mockRejectedValue(new TypeError('reply lost'));
  await act(async () => {
    await result.current.undoChange(result.current.undo[0]!);
  });
  expect(result.current.states.one?.phase).toBe('unknown');
  await act(async () => {
    await result.current.reconcile('one');
  });
  expect(result.current.states.one?.phase).toBe('unknown');
  client.listCatalogUpdateProfiles.mockResolvedValue([{ ...profile, version: 3 }]);
  await act(async () => {
    await result.current.reconcile('one');
  });
  expect(result.current.states.one?.phase).toBe('saved');
  expect(result.current.undo).toHaveLength(0);
  expect(client.patchCatalogUpdateProfile).toHaveBeenCalledTimes(2);
});
it('keeps a failed Undo preflight retryable because no inverse was sent', async () => {
  const { result, client } = setup();
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  client.listCatalogUpdateProfiles.mockRejectedValue(new TypeError('offline'));
  await act(async () => {
    await result.current.undoChange(result.current.undo[0]!);
  });
  expect(result.current.states.one?.phase).toBe('error');
  expect(result.current.blocked('one')).toBe(false);
  expect(client.patchCatalogUpdateProfile).toHaveBeenCalledTimes(1);
});
it('loads the actual version after conflict without overwriting it', async () => {
  const patch = vi.fn().mockRejectedValue(new TeamApiError('STALE_RESULT', false));
  const { result, client } = setup(patch);
  client.listCatalogUpdateProfiles.mockResolvedValue([
    { ...profile, version: 5, refreshTexts: false }
  ]);
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  expect(result.current.states.one?.phase).toBe('conflict');
  expect(result.current.snapshotFor('one')?.profile.refreshTexts).toBe(false);
  expect(patch).toHaveBeenCalledTimes(1);
});
it('undo reads the current version and refuses to overwrite a later change', async () => {
  const { result, client } = setup();
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  const entry = result.current.undo[0]!;
  client.listCatalogUpdateProfiles.mockResolvedValue([
    { ...profile, restitch: true, version: 3, refreshImages: false }
  ]);
  await act(async () => {
    await result.current.undoChange(entry);
  });
  expect(client.patchCatalogUpdateProfile).toHaveBeenCalledTimes(1);
  expect(result.current.undo[0]?.invalid).toBe(true);
  expect(result.current.snapshotFor('one')?.profile.refreshImages).toBe(false);
});
it('undo restores only the changed field with the verified version', async () => {
  const { result, client } = setup();
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  const entry = result.current.undo[0]!;
  client.listCatalogUpdateProfiles.mockResolvedValue([{ ...profile, restitch: true, version: 2 }]);
  client.patchCatalogUpdateProfile.mockResolvedValue({ ...profile, version: 3 });
  await act(async () => {
    await result.current.undoChange(entry);
  });
  expect(client.patchCatalogUpdateProfile).toHaveBeenLastCalledWith('team', 'one', 2, {
    restitch: false
  });
  expect(result.current.undo).toHaveLength(0);
});
it('keeps a known refusal at the confirmed value', async () => {
  const { result } = setup(vi.fn().mockRejectedValue(new TeamApiError('PERMISSION_DENIED', false)));
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  expect(result.current.snapshotFor('one')?.profile.restitch).toBe(false);
  expect(result.current.undo).toHaveLength(0);
  expect(result.current.states.one?.phase).toBe('error');
});
it('places video first and moves focus without changing data', async () => {
  const onChange = vi.fn();
  render(<CatalogIconControls profile={profile} name="Catalog" onChange={onChange} />);
  const toolbar = screen.getByRole('toolbar');
  const buttons = toolbar.querySelectorAll('button');
  expect(buttons[0]?.dataset.catalogField).toBe('restitch');
  expect([...buttons].filter(button => button.tabIndex === 0)).toHaveLength(1);
  buttons[0]?.focus();
  fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(buttons[1]);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(buttons[1]!);
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('randomLinkVariation', false));
});
it('accepts fresh runtime facts from the registry when the profile version is unchanged', async () => {
  const patch = vi
    .fn()
    .mockResolvedValue({ ...profile, restitch: true, version: 2, restitchStatus: 'waiting' });
  const client = {
    getCatalogUpdater: vi.fn(),
    listTeamProductCatalogs: vi.fn(),
    patchCatalogUpdateProfile: patch
  };
  const props = { rows: [row] };
  const { result, rerender } = renderHook(
    ({ rows }) => useCatalogInlineChanges({ teamId: 'team', client, rows, reload: vi.fn() }),
    { initialProps: props }
  );
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  expect(result.current.snapshotFor('one')?.profile.restitchStatus).toBe('waiting');
  rerender({
    rows: [
      {
        ...row,
        profile: {
          ...profile,
          version: 2,
          restitch: false,
          restitchStatus: 'ready',
          lastSuccessfulAt: '2026-10-18T10:00:00Z',
          lastResult: 'success'
        }
      }
    ]
  });
  expect(result.current.snapshotFor('one')?.profile.restitch).toBe(true);
  expect(result.current.snapshotFor('one')?.profile.restitchStatus).toBe('ready');
  expect(result.current.snapshotFor('one')?.profile.lastSuccessfulAt).toBe('2026-10-18T10:00:00Z');
});
it('does not intercept browser or assistive-technology modified arrow keys', () => {
  render(<CatalogIconControls profile={profile} name="Catalog" onChange={vi.fn()} />);
  const toolbar = screen.getByRole('toolbar');
  const first = toolbar.querySelector('button')!;
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowRight', ctrlKey: true, altKey: true });
  expect(document.activeElement).toBe(first);
});

it('saves schedule atomically and reconciles an uncertain response including its anchor', async () => {
  const schedule = { timeZone: 'Europe/Kyiv', weekday: 7, time: '18:00' };
  const patch = vi.fn().mockRejectedValue(new TypeError('network'));
  const { result, client } = setup(patch);
  client.listCatalogUpdateProfiles.mockResolvedValue([{ ...profile, schedule, version: 2 }]);
  client.listTeamProductCatalogs.mockResolvedValue([{ ...row, updateInterval: '1w' }]);
  let confirmed: boolean | undefined;
  await act(async () => {
    confirmed = await result.current.change('one', 'schedule', { interval: '1w', schedule });
  });
  expect(confirmed).toBe(true);
  expect(patch).toHaveBeenCalledWith('team', 'one', 1, { updateInterval: '1w', schedule });
  expect(result.current.snapshotFor('one')?.profile.schedule).toEqual(schedule);
  expect(result.current.undo[0]?.before).toEqual({ interval: null, schedule: null });
});
it('reports a conflict when readback has a different clock', async () => {
  const schedule = { timeZone: 'Europe/Kyiv', weekday: 7, time: '18:00' };
  const { result, client } = setup(vi.fn().mockRejectedValue(new TypeError('network')));
  client.listCatalogUpdateProfiles.mockResolvedValue([
    { ...profile, schedule: { ...schedule, time: '19:00' }, version: 2 }
  ]);
  client.listTeamProductCatalogs.mockResolvedValue([{ ...row, updateInterval: '1w' }]);
  let confirmed: boolean | undefined;
  await act(async () => {
    confirmed = await result.current.change('one', 'schedule', { interval: '1w', schedule });
  });
  expect(confirmed).toBe(false);
  expect(result.current.states.one.phase).toBe('conflict');
});

it('uses the authoritative calendar due time rather than forecasting a confirmed result', async () => {
  const schedule = { timeZone: 'Europe/Kyiv', weekday: 7, time: '18:00' };
  const nextRunAt = '2026-11-08T16:00:00Z';
  const saved = { ...profile, schedule, version: 2 };
  const client = {
    getCatalogUpdater: vi.fn(),
    listTeamProductCatalogs: vi
      .fn()
      .mockResolvedValue([{ ...row, profile: saved, updateInterval: '1w', nextRunAt }]),
    listCatalogUpdateProfiles: vi.fn().mockResolvedValue([saved]),
    patchCatalogUpdateProfile: vi.fn().mockResolvedValue(saved)
  };
  const { result } = renderHook(() =>
    useCatalogInlineChanges({ teamId: 'team', client, rows: [row], reload: vi.fn() })
  );
  await act(async () => {
    await result.current.change('one', 'schedule', { interval: '1w', schedule });
  });
  expect(result.current.states.one.phase).toBe('saved');
  expect(result.current.snapshotFor('one')?.nextRunAt).toBe(nextRunAt);
  expect(client.listTeamProductCatalogs).toHaveBeenCalledTimes(1);
});

it('keeps a typed server refusal in the correlated diagnostic flow and the schedule picker', async () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const { result } = setup(vi.fn().mockRejectedValue(new TeamApiError('PERMISSION_DENIED', false)));
  await act(async () => {
    await expect(
      result.current.saveSchedule('one', { interval: '15h', schedule: null })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  const failure = track.mock.calls.find(([event]) => event === 'operation_failed');
  expect(failure?.[1]).toMatchObject({
    flow_step: 'catalog_manager_profile',
    action_identifier: 'save_requested',
    error_code: 'PERMISSION_DENIED',
    attempt_id: expect.any(String),
    flow_id: expect.any(String)
  });
  expect(result.current.states.one).toMatchObject({ phase: 'error', code: 'PERMISSION_DENIED' });
});

it('ignores late save acknowledgement from the previous team and clears its undo/state', async () => {
  let resolve!: (profile: CatalogUpdateProfile) => void;
  const patch = vi.fn().mockReturnValue(
    new Promise<CatalogUpdateProfile>(r => {
      resolve = r;
    })
  );
  const client = {
    getCatalogUpdater: vi.fn(),
    listTeamProductCatalogs: vi.fn(),
    patchCatalogUpdateProfile: patch
  };
  const reload = vi.fn();
  const onChanged = vi.fn();
  const hook = renderHook(
    ({ teamId }) => useCatalogInlineChanges({ teamId, client, rows: [row], reload, onChanged }),
    { initialProps: { teamId: 'old' } }
  );
  let pending!: Promise<boolean>;
  act(() => {
    pending = hook.result.current.change('one', 'restitch', true);
  });
  hook.rerender({ teamId: 'new' });
  await act(async () => {
    resolve({ ...profile, version: 2, restitch: true });
    await pending;
  });
  expect(await pending).toBe(false);
  expect(hook.result.current.undo).toEqual([]);
  expect(hook.result.current.states).toEqual({});
  expect(reload).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
});
it('does not refresh or publish a save result after unmount', async () => {
  let resolve!: (profile: CatalogUpdateProfile) => void;
  const patch = vi.fn().mockReturnValue(
    new Promise<CatalogUpdateProfile>(r => {
      resolve = r;
    })
  );
  const hook = setup(patch);
  let pending!: Promise<boolean>;
  act(() => {
    pending = hook.result.current.change('one', 'restitch', true);
  });
  hook.unmount();
  resolve({ ...profile, version: 2, restitch: true });
  expect(await pending).toBe(false);
});

it('does not confirm a save acknowledgement with an unexpected settings version', async () => {
  const hook = setup(vi.fn().mockResolvedValue({ ...profile, restitch: true, version: 1 }));
  let confirmed = true;
  await act(async () => {
    confirmed = await hook.result.current.change('one', 'restitch', true);
  });
  expect(confirmed).toBe(false);
  expect(hook.client.listCatalogUpdateProfiles).toHaveBeenCalledTimes(1);
  expect(hook.result.current.undo).toHaveLength(0);
});

it('does not replace a newer readback runtime with an older same-version registry response', async () => {
  const saved = { ...profile, version: 2, restitch: true, restitchStatus: 'ready' as const };
  const client = {
    getCatalogUpdater: vi.fn(),
    listTeamProductCatalogs: vi.fn(),
    listCatalogManagerSnapshot: vi.fn().mockResolvedValue({
      rows: [{ ...row, profile: saved, runtimeObservedAt: '2026-11-05T12:02:00Z' }],
      invalidRowCount: 0
    }),
    patchCatalogUpdateProfile: vi.fn().mockRejectedValue(new TypeError('lost reply'))
  };
  const { result, rerender } = renderHook(
    ({ rows }) => useCatalogInlineChanges({ teamId: 'team', client, rows, reload: vi.fn() }),
    { initialProps: { rows: [row] } }
  );
  await act(async () => {
    await result.current.change('one', 'restitch', true);
  });
  expect(result.current.snapshotFor('one')?.profile.restitchStatus).toBe('ready');
  rerender({
    rows: [
      {
        ...row,
        profile: { ...saved, restitchStatus: 'waiting' },
        runtimeObservedAt: '2026-11-05T12:01:00Z'
      } as CatalogRegistryRow
    ]
  });
  expect(result.current.snapshotFor('one')?.profile.restitchStatus).toBe('ready');
  rerender({
    rows: [
      {
        ...row,
        profile: { ...saved, restitchStatus: 'blocked' },
        runtimeObservedAt: '2026-11-05T12:03:00Z'
      } as CatalogRegistryRow
    ]
  });
  expect(result.current.snapshotFor('one')?.profile.restitchStatus).toBe('blocked');
  rerender({
    rows: [
      {
        ...row,
        profile: { ...saved, restitchStatus: 'waiting' },
        runtimeObservedAt: '2026-11-05T12:01:00Z'
      } as CatalogRegistryRow
    ]
  });
  expect(result.current.snapshotFor('one')?.profile.restitchStatus).toBe('blocked');
});

it('does not present an older acknowledgement as the visible settings after a newer version was observed', async () => {
  let finish!: (value: CatalogUpdateProfile) => void;
  const client = {
    getCatalogUpdater: vi.fn(),
    listTeamProductCatalogs: vi.fn(),
    patchCatalogUpdateProfile: vi.fn(
      () =>
        new Promise<CatalogUpdateProfile>(resolve => {
          finish = resolve;
        })
    )
  };
  const { result, rerender } = renderHook(
    ({ rows }) => useCatalogInlineChanges({ teamId: 'team', client, rows, reload: vi.fn() }),
    { initialProps: { rows: [row] } }
  );
  let save!: Promise<boolean>;
  act(() => {
    save = result.current.change('one', 'restitch', true);
  });
  rerender({ rows: [{ ...row, profile: { ...profile, version: 3, restitch: false } }] });
  expect(result.current.snapshotFor('one')?.profile.version).toBe(3);
  let confirmed = true;
  await act(async () => {
    finish({ ...profile, version: 2, restitch: true });
    confirmed = await save;
  });
  expect(confirmed).toBe(false);
  expect(result.current.states.one.phase).toBe('conflict');
  expect(result.current.snapshotFor('one')?.profile).toMatchObject({ version: 3, restitch: false });
  expect(result.current.undo).toEqual([]);
});
