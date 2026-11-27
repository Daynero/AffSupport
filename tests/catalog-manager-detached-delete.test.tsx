// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamApiError, teamApi, type CatalogRegistryRow } from '../apps/web/src/api/team';
import { catalogErrorMessageFor } from '../apps/web/src/team/catalogFixActions';
import { useCatalogManagerTrash } from '../apps/web/src/team/catalog-updater/useCatalogManagerTrash';

const id = (n: number) => `48000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const teamId = id(1);
const t = ((key: string) => key) as Parameters<typeof catalogErrorMessageFor>[1];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Production 2026-11-27: «Оновити зараз» refused AGENT_REQUIRED read «Soty не запущений на цьому
// компʼютері» while Soty was connected; what was missing was background work for the space.
it('reads a refused run as missing background work, not as Soty not running', () => {
  expect(catalogErrorMessageFor(new TeamApiError('AGENT_REQUIRED', false), t)).toBe(
    'catalogWaitAgentRequired'
  );
  expect(catalogErrorMessageFor(new TeamApiError('AGENT_UPDATE_REQUIRED', false), t)).toBe(
    'catalogWaitAgentUpdateRequired'
  );
  expect(catalogErrorMessageFor(new TeamApiError('NOT_FOUND', false), t)).toBe('teamErrorNotFound');
});

// Production 2026-11-27 (DimSok): deleting a catalog in the space's previous Drive folder asked
// Drive to trash a sheet Soty can no longer reach — «У вас немає дозволу на цю дію».
it('takes catalogs in the previous Drive folder out of Soty and trashes the rest on Drive', async () => {
  const detached = id(2);
  const current = id(3);
  const row = (catalogId: string, state: string) =>
    ({
      catalogId,
      name: catalogId,
      driveConnection: { state }
    }) as unknown as CatalogRegistryRow;
  const forget = vi.spyOn(teamApi, 'forgetDetachedCatalog').mockResolvedValue(undefined);
  const trash = vi.spyOn(teamApi, 'trashMaterial').mockImplementation(
    async input =>
      ({
        state: 'succeeded',
        materialId: input.materialId
      }) as Awaited<ReturnType<typeof teamApi.trashMaterial>>
  );
  const setConfirmDelete = vi.fn();
  const reload = vi.fn();
  const { result } = renderHook(() =>
    useCatalogManagerTrash({
      teamId,
      rows: [row(detached, 'detached'), row(current, 'connected')],
      permissions: null,
      owner: { current: () => true } as never,
      withBusy: async (_ids, work) => work(),
      setSelected: () => undefined,
      confirmDelete: [detached, current],
      setConfirmDelete,
      reload,
      push: vi.fn(),
      t: t as never
    })
  );
  await act(async () => {
    await result.current.deleteSelected();
  });
  expect(forget).toHaveBeenCalledExactlyOnceWith(teamId, detached);
  expect(trash).toHaveBeenCalledOnce();
  expect(trash.mock.calls[0]![0]).toMatchObject({ teamId, materialId: current });
  expect(setConfirmDelete).toHaveBeenLastCalledWith([]);
  expect(reload).toHaveBeenCalled();
});
