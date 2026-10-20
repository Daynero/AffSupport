// @vitest-environment jsdom
import React from 'react';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountArchiveDrawer } from '../apps/web/src/team/accounts/AccountArchiveDrawer';
import {
  accountsWorkspaceApi,
  type ArchivedAccountItem
} from '../apps/web/src/api/team-accounts-workspace';
vi.mock('../apps/web/src/team/accounts/analytics', () => ({
  accountFlowId: () => crypto.randomUUID(),
  emitAccountSignal: vi.fn()
}));
vi.mock('../apps/web/src/api/team-accounts-workspace', () => ({
  accountsWorkspaceApi: { listArchive: vi.fn(), preflight: vi.fn(), archive: vi.fn() }
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(emitAccountSignal).mockReset();
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Promise not initialized');
  };
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}
const archived: ArchivedAccountItem = {
  id: 'social',
  entityKind: 'social',
  name: 'Archived Social',
  archivedAt: '2026-10-18T01:00:00Z',
  parentArchived: false,
  canRestore: true
};
it.each(['unmount', 'team change', 'permission loss'] as const)(
  'does not restore after %s while preflight is pending',
  async interruption => {
    vi.mocked(accountsWorkspaceApi.listArchive).mockResolvedValue({
      items: [archived],
      next: null
    });
    const preflight = deferred<Awaited<ReturnType<typeof accountsWorkspaceApi.preflight>>>();
    vi.mocked(accountsWorkspaceApi.preflight).mockReturnValue(preflight.promise);
    const onRestore = vi.fn().mockResolvedValue(undefined);
    const props = { teamId: 'original-team', canEdit: true, onClose: vi.fn(), onRestore };
    const view = render(<AccountArchiveDrawer {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Archived Social' }));
    expect(accountsWorkspaceApi.preflight).toHaveBeenCalledTimes(1);
    if (interruption === 'unmount') view.unmount();
    else if (interruption === 'team change')
      view.rerender(<AccountArchiveDrawer {...props} teamId="other-team" />);
    else view.rerender(<AccountArchiveDrawer {...props} canEdit={false} />);
    await act(async () => {
      preflight.resolve({
        entityId: 'social',
        entityKind: 'social',
        lifecycleVersion: '1',
        token: 'token',
        archivedAt: archived.archivedAt,
        effectiveArchived: true,
        childCount: 1
      });
    });
    expect(accountsWorkspaceApi.archive).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(emitAccountSignal)
        .mock.calls.some(([, stage]) => stage === 'accepted' || stage === 'applied')
    ).toBe(false);
  }
);
it('does not append a stale next page after the archive search changes', async () => {
  const oldPage = deferred<Awaited<ReturnType<typeof accountsWorkspaceApi.listArchive>>>();
  const fresh: ArchivedAccountItem = {
    ...archived,
    id: 'fresh',
    name: 'Fresh result'
  };
  vi.mocked(accountsWorkspaceApi.listArchive).mockImplementation(async (_team, query, cursor) => {
    if (cursor) return oldPage.promise;
    return query ? { items: [fresh], next: null } : { items: [archived], next: 'cursor-1' };
  });
  render(
    <AccountArchiveDrawer
      teamId="team"
      canEdit
      onClose={vi.fn()}
      onRestore={vi.fn().mockResolvedValue(undefined)}
    />
  );
  await screen.findByText('Archived Social');
  fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
  await waitFor(() =>
    expect(accountsWorkspaceApi.listArchive).toHaveBeenCalledWith('team', '', 'cursor-1')
  );
  fireEvent.change(screen.getByLabelText('Find an archived social or ad account'), {
    target: { value: 'Fresh' }
  });
  await screen.findByText('Fresh result');
  await act(async () => {
    oldPage.resolve({
      items: [{ ...archived, id: 'stale-page', name: 'Stale old query' }],
      next: null
    });
  });
  expect(screen.queryByText('Stale old query')).toBeNull();
  expect(screen.getByText('Fresh result')).toBeTruthy();
});

function configureRestore() {
  vi.mocked(accountsWorkspaceApi.preflight).mockResolvedValue({
    entityId: 'social',
    entityKind: 'social',
    lifecycleVersion: '1',
    token: 'before',
    archivedAt: archived.archivedAt,
    effectiveArchived: true,
    childCount: 1
  });
  vi.mocked(accountsWorkspaceApi.archive).mockResolvedValue({
    entityId: 'social',
    entityKind: 'social',
    lifecycleVersion: '2',
    token: 'after',
    archivedAt: null,
    effectiveArchived: false,
    childCount: 1,
    requestId: crypto.randomUUID(),
    operationId: crypto.randomUUID()
  });
}
function restoredProofs() {
  return vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(([action, stage]) => action === 'lifecycle' && stage === 'applied');
}
it('proves restored only after canonical reread removes the row in a React commit', async () => {
  configureRestore();
  vi.mocked(emitAccountSignal).mockImplementation((action, stage) => {
    if (action === 'lifecycle' && stage === 'applied') {
      expect(screen.queryByText('Archived Social')).toBeNull();
      expect(screen.getByText('The archive is empty')).toBeTruthy();
    }
  });
  const canonical = deferred<Awaited<ReturnType<typeof accountsWorkspaceApi.listArchive>>>();
  const refresh = deferred<void>();
  vi.mocked(accountsWorkspaceApi.listArchive)
    .mockResolvedValueOnce({ items: [archived], next: null })
    .mockReturnValue(canonical.promise);
  const onRestore = vi.fn(() => refresh.promise);
  render(<AccountArchiveDrawer teamId="team" canEdit onClose={vi.fn()} onRestore={onRestore} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore Archived Social' }));
  await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
  expect(vi.mocked(emitAccountSignal).mock.calls.some(([, stage]) => stage === 'accepted')).toBe(
    true
  );
  expect(restoredProofs()).toHaveLength(0);
  expect(screen.getByText('Archived Social')).toBeTruthy();
  await act(async () => {
    refresh.resolve();
  });
  await waitFor(() => expect(accountsWorkspaceApi.listArchive).toHaveBeenCalledTimes(2));
  expect(restoredProofs()).toHaveLength(0);
  await act(async () => {
    canonical.resolve({ items: [], next: null });
  });
  await waitFor(() => expect(restoredProofs()).toHaveLength(1));
  expect(screen.queryByText('Archived Social')).toBeNull();
  expect(restoredProofs()[0][2]).toMatchObject({
    result: 'restored',
    coverage: 'accounts_only',
    outcome: 'success'
  });
});
it('keeps accepted restoration visibility unknown when the canonical reread fails', async () => {
  configureRestore();
  vi.mocked(accountsWorkspaceApi.listArchive)
    .mockResolvedValueOnce({ items: [archived], next: null })
    .mockRejectedValue(new Error('INVALID_RESPONSE'));
  render(
    <AccountArchiveDrawer
      teamId="team"
      canEdit
      onClose={vi.fn()}
      onRestore={vi.fn().mockResolvedValue(undefined)}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Restore Archived Social' }));
  await screen.findByText('Could not load the accounts.');
  expect(vi.mocked(emitAccountSignal).mock.calls.some(([, stage]) => stage === 'accepted')).toBe(
    true
  );
  expect(restoredProofs()).toHaveLength(0);
});
