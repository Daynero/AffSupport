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
afterEach(cleanup);
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
          restitch: true,
          restitchStatus: 'ready',
          lastSuccessfulAt: '2026-10-18T10:00:00Z',
          lastResult: 'success'
        }
      }
    ]
  });
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
it('does not confirm a schedule when readback has a different clock', async () => {
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
  expect(result.current.states.one.phase).toBe('unknown');
});

it('retains one immediate schedule forecast until authoritative registry readback replaces it', async () => {
  const schedule = { timeZone: 'Europe/Kyiv', weekday: 7, time: '18:00' };
  const oldNext = '2026-10-26T07:00:00Z';
  let rows = [
    {
      ...row,
      updateInterval: '1w',
      nextRunAt: oldNext,
      profile: { ...profile, schedule: { ...schedule, weekday: 1, time: '09:00' } }
    }
  ] as CatalogRegistryRow[];
  const patch = vi.fn().mockResolvedValue({ ...profile, schedule, version: 2 });
  const client = {
    getCatalogUpdater: vi.fn(),
    listTeamProductCatalogs: vi.fn(),
    patchCatalogUpdateProfile: patch
  };
  const { result, rerender } = renderHook(() =>
    useCatalogInlineChanges({ teamId: 'team', client, rows, reload: vi.fn() })
  );
  await act(async () => {
    await result.current.change('one', 'schedule', { interval: '1w', schedule });
  });
  const forecast = result.current.snapshotFor('one')?.nextRunAt;
  expect(forecast).toBeTruthy();
  expect(forecast).not.toBe(oldNext);
  expect(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Kyiv',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date(forecast!))
  ).toBe('18:00');
  rerender();
  expect(result.current.snapshotFor('one')?.nextRunAt).toBe(forecast);
  const authoritative = new Date(Date.parse(forecast!) + 7 * 86400000).toISOString();
  rows = [{ ...rows[0], profile: { ...profile, schedule, version: 2 }, nextRunAt: authoritative }];
  rerender();
  expect(result.current.snapshotFor('one')?.nextRunAt).toBe(authoritative);
});
