// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../apps/web/src/analytics/service', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/analytics/service')>()),
  analytics: { track, journalContext: () => ({ userId: '47000000-0000-4000-8000-000000000001' }) }
}));
import { useCatalogCommands } from '../apps/web/src/team/catalog-updater/useCatalogCommands';
import { CatalogCommandJournal } from '../apps/web/src/team/catalog-updater/catalogCommandJournal';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { deferred } from './fixtures/catalog-sync';
import type { CatalogCommandRequest } from '@video-compressor/shared';
const id = (n: number) => `47000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1),
  teamId = id(2),
  catalogId = id(3);
const receipt = (intent: CatalogCommandRequest) => ({
  commandId: intent.commandId,
  kind: 'run' as const,
  status: 'accepted' as const,
  sourceAttemptId: null,
  requestedCount: 1,
  acceptedCount: 1,
  items: [{ catalogId, accepted: true, attemptId: id(5), reason: 'accepted' as const }]
});
function fixture(overrides: Record<string, unknown> = {}) {
  const client = {
    requestCatalogUpdateCommand: vi.fn(
      async (_team: string, _actor: string, intent: CatalogCommandRequest) => receipt(intent)
    ),
    getCatalogUpdateCommand: vi.fn().mockResolvedValue(null),
    cancelCatalogCommandIntent: vi.fn().mockResolvedValue(null),
    ...overrides
  };
  const onConfirmed = vi.fn();
  const reloadFresh = vi.fn().mockResolvedValue(true);
  const view = renderHook(() => useCatalogCommands({ teamId, client, onConfirmed, reloadFresh }));
  return { view, client, onConfirmed, reloadFresh };
}
beforeEach(() => {
  track.mockReset();
  setPrivateCacheScope(actor, 'owner');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('persists before dispatch and keeps acceptance blocked until a fresh registry read succeeds', async () => {
  const fresh = deferred<boolean>();
  let persistedAtWrite = false;
  const h = fixture({
    requestCatalogUpdateCommand: vi.fn(
      async (_t: string, _a: string, intent: CatalogCommandRequest) => {
        persistedAtWrite = new CatalogCommandJournal(actor, teamId, localStorage)
          .list()
          .some(value => value.commandId === intent.commandId);
        return receipt(intent);
      }
    )
  });
  h.reloadFresh.mockReturnValue(fresh.promise);
  let pending!: ReturnType<typeof h.view.result.current.submit>;
  await act(async () => {
    pending = h.view.result.current.submit([catalogId]);
  });
  expect(persistedAtWrite).toBe(true);
  expect(h.view.result.current.blocked(catalogId)).toBe(true);
  expect(h.onConfirmed).toHaveBeenCalledTimes(1);
  await act(async () => {
    fresh.resolve(false);
    await pending;
  });
  expect(h.view.result.current.blocked(catalogId)).toBe(true);
  h.reloadFresh.mockResolvedValue(true);
  await act(async () => h.view.result.current.refresh());
  expect(h.view.result.current.blocked(catalogId)).toBe(false);
});
it('restores unknown requests on reopen with read-only lookups and no re-execution', async () => {
  const h = fixture({
    requestCatalogUpdateCommand: vi.fn().mockRejectedValue(new TypeError('lost reply'))
  });
  await act(async () => {
    expect((await h.view.result.current.submit([catalogId])).kind).toBe('unknown');
  });
  const saved = new CatalogCommandJournal(actor, teamId, localStorage).list()[0]!;
  expect(h.view.result.current.blocked(catalogId)).toBe(true);
  h.view.unmount();
  const next = fixture({ getCatalogUpdateCommand: vi.fn().mockResolvedValue(receipt(saved)) });
  await act(async () => {});
  expect(next.client.requestCatalogUpdateCommand).not.toHaveBeenCalled();
  expect(next.client.getCatalogUpdateCommand).toHaveBeenCalledTimes(1);
  expect(next.onConfirmed).toHaveBeenCalledWith(receipt(saved), 'read');
  expect(new CatalogCommandJournal(actor, teamId, localStorage).list()).toEqual([]);
});
it('suppresses a late accepted receipt immediately after the actor epoch changes', async () => {
  const remote = deferred<ReturnType<typeof receipt>>();
  let request!: CatalogCommandRequest;
  const h = fixture({
    requestCatalogUpdateCommand: vi.fn((_t: string, _a: string, intent: CatalogCommandRequest) => {
      request = intent;
      return remote.promise;
    })
  });
  let pending!: ReturnType<typeof h.view.result.current.submit>;
  await act(async () => {
    pending = h.view.result.current.submit([catalogId]);
  });
  await act(async () => {
    setPrivateCacheScope(id(9), 'owner');
    remote.resolve(receipt(request));
    expect((await pending).kind).toBe('obsolete');
  });
  expect(h.onConfirmed).not.toHaveBeenCalled();
  expect(new CatalogCommandJournal(actor, teamId, localStorage).list()).toHaveLength(1);
  expect(new CatalogCommandJournal(id(9), teamId, localStorage).list()).toEqual([]);
});
it('refuses a mutation when persistent storage is unavailable', async () => {
  const h = fixture();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });
  await act(async () => {
    expect(await h.view.result.current.submit([catalogId])).toMatchObject({
      kind: 'rejected',
      error: { code: 'CATALOG_COMMAND_STORAGE_UNAVAILABLE' }
    });
  });
  expect(h.client.requestCatalogUpdateCommand).not.toHaveBeenCalled();
});
it('does not use legacy commands when the command endpoint is unavailable', async () => {
  const h = fixture({ requestCatalogUpdateCommand: undefined });
  await act(async () => {
    expect(await h.view.result.current.submit([catalogId])).toMatchObject({
      kind: 'rejected',
      error: { code: 'CATALOG_COMMAND_UNSUPPORTED' }
    });
  });
  expect(new CatalogCommandJournal(actor, teamId, localStorage).list()).toEqual([]);
});
it('creates a fresh active read owner through StrictMode effect replay without writing', async () => {
  const intent = { commandId: id(6), catalogIds: [catalogId], createdAt: 1 };
  new CatalogCommandJournal(actor, teamId, localStorage).put(intent);
  const client = {
    requestCatalogUpdateCommand: vi.fn(),
    getCatalogUpdateCommand: vi.fn().mockResolvedValue(receipt(intent))
  };
  const onConfirmed = vi.fn();
  const view = renderHook(
    () => useCatalogCommands({ teamId, client, onConfirmed, reloadFresh: async () => true }),
    { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> }
  );
  await act(async () => {});
  expect(client.requestCatalogUpdateCommand).not.toHaveBeenCalled();
  expect(onConfirmed).toHaveBeenCalledTimes(1);
  expect(view.result.current.states).toEqual([]);
});

it('ignores an old team receipt when the hook is reused without an actor change', async () => {
  const remote = deferred<ReturnType<typeof receipt>>();
  let request!: CatalogCommandRequest;
  const client = {
    requestCatalogUpdateCommand: vi.fn((_t: string, _a: string, intent: CatalogCommandRequest) => {
      request = intent;
      return remote.promise;
    }),
    getCatalogUpdateCommand: vi.fn().mockResolvedValue(null)
  };
  const onConfirmed = vi.fn();
  const view = renderHook(
    ({ team }) =>
      useCatalogCommands({ teamId: team, client, onConfirmed, reloadFresh: async () => true }),
    { initialProps: { team: teamId } }
  );
  let pending!: ReturnType<typeof view.result.current.submit>;
  await act(async () => {
    pending = view.result.current.submit([catalogId]);
  });
  view.rerender({ team: id(8) });
  await act(async () => {
    remote.resolve(receipt(request));
    expect((await pending).kind).toBe('obsolete');
  });
  expect(onConfirmed).not.toHaveBeenCalled();
  expect(new CatalogCommandJournal(actor, teamId, localStorage).list()).toHaveLength(1);
  expect(view.result.current.states).toEqual([]);
});

it.each(['STALE_RESULT', 'CATALOG_UPDATE_RECONCILIATION_REQUIRED'] as const)(
  'keeps an explicit transactional %s refusal distinct from a lost acknowledgement',
  async code => {
    const { TeamApiError } = await import('../apps/web/src/api/team');
    const h = fixture({
      requestCatalogUpdateCommand: vi.fn().mockRejectedValue(new TeamApiError(code, false))
    });
    await act(async () => {
      expect(await h.view.result.current.submit([catalogId])).toMatchObject({
        kind: 'rejected',
        error: { code }
      });
    });
    expect(h.client.getCatalogUpdateCommand).not.toHaveBeenCalled();
    expect(h.view.result.current.blocked(catalogId)).toBe(false);
    expect(new CatalogCommandJournal(actor, teamId, localStorage).list()).toEqual([]);
  }
);

it.each(['already_pending', 'reconciliation_required'] as const)(
  'requires a fresh registry status even when zero new work was accepted: %s',
  async reason => {
    const fresh = deferred<boolean>();
    const h = fixture({
      requestCatalogUpdateCommand: vi.fn(
        async (_t: string, _a: string, intent: CatalogCommandRequest) => ({
          ...receipt(intent),
          acceptedCount: 0,
          items: [{ catalogId, accepted: false, attemptId: null, reason }]
        })
      )
    });
    h.reloadFresh.mockReturnValue(fresh.promise);
    let pending!: ReturnType<typeof h.view.result.current.submit>;
    await act(async () => {
      pending = h.view.result.current.submit([catalogId]);
    });
    expect(h.reloadFresh).toHaveBeenCalledTimes(1);
    expect(h.view.result.current.blocked(catalogId)).toBe(true);
    expect(await h.view.result.current.submit([catalogId])).toMatchObject({ kind: 'rejected' });
    expect(h.client.requestCatalogUpdateCommand).toHaveBeenCalledTimes(1);
    await act(async () => {
      fresh.resolve(true);
      await pending;
    });
    expect(h.view.result.current.blocked(catalogId)).toBe(false);
  }
);

it('diagnoses storage refusal before a coordinator can be created without sending a command', async () => {
  localStorage.setItem(`soty.catalog-command.v1:${actor}:${teamId}:${id(90)}`, '{');
  const h = fixture();
  await act(async () => {
    expect(await h.view.result.current.submit([catalogId])).toMatchObject({
      kind: 'rejected',
      error: { code: 'CATALOG_COMMAND_STORAGE_UNAVAILABLE' }
    });
  });
  expect(h.client.requestCatalogUpdateCommand).not.toHaveBeenCalled();
  expect(track.mock.calls.find(([event]) => event === 'operation_failed')?.[1]).toMatchObject({
    flow_step: 'catalog_manager_run',
    action_identifier: 'command_requested',
    error_code: 'CATALOG_COMMAND_STORAGE_UNAVAILABLE',
    error_stage: 'library',
    error_fingerprint: 'team:library:CATALOG_COMMAND_STORAGE_UNAVAILABLE',
    production_completed: false
  });
});
it('preserves the last closed readback cause and identifies checking as the failed stage', async () => {
  const { TeamApiError } = await import('../apps/web/src/api/team');
  const h = fixture({
    requestCatalogUpdateCommand: vi.fn().mockRejectedValue(new TypeError('lost reply')),
    getCatalogUpdateCommand: vi.fn().mockRejectedValue(new TeamApiError('PERMISSION_DENIED', false))
  });
  await act(async () => {
    expect((await h.view.result.current.submit([catalogId])).kind).toBe('unknown');
  });
  const command = h.view.result.current.states[0]!.intent.commandId;
  track.mockClear();
  await act(async () => h.view.result.current.check(command));
  expect(h.client.requestCatalogUpdateCommand).toHaveBeenCalledTimes(1);
  expect(track.mock.calls.find(([event]) => event === 'operation_failed')?.[1]).toMatchObject({
    error_code: 'PERMISSION_DENIED',
    action_identifier: 'readback_requested',
    error_fingerprint: 'team:library:PERMISSION_DENIED'
  });
});
it('refuses an explicit invalid retry source instead of turning it into an ordinary Run', async () => {
  const h = fixture();
  await act(async () => {
    expect(await h.view.result.current.submit([catalogId], '')).toMatchObject({
      kind: 'rejected',
      error: { code: 'INVALID_INPUT' }
    });
  });
  expect(h.client.requestCatalogUpdateCommand).not.toHaveBeenCalled();
});
