// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageHealth } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { StorageChip } from '../apps/web/src/team/storage/StorageChip';
import { useStorageHealth } from '../apps/web/src/team/storage/useStorageHealth';

vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ revision: 0 })
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('storage health under incomplete provider access', () => {
  it('retains the last confirmed health snapshot when a later health read fails', async () => {
    const current: StorageHealth = {
      kind: 'connected',
      lastReconciledAt: '2026-09-24T10:00:00Z'
    };
    const getStorageHealth = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockRejectedValueOnce(new Error('provider temporarily unavailable'));
    const client = { getStorageHealth };
    const { result } = renderHook(() => useStorageHealth({ teamId: 'team-1', client }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.health).toEqual(current);
    await act(async () => result.current.refresh());
    expect(result.current.health).toEqual(current);
  });

  it('distinguishes an empty confirmed catalog from an indexing catalog', () => {
    const view = (health: StorageHealth) =>
      render(
        <ToastProvider>
          <StorageChip
            teamId="team-1"
            health={health}
            client={{}}
            isOwner
            canManage
            settingsHref="/team/explorer?settings=1"
          />
        </ToastProvider>
      );
    view({ kind: 'connected', lastReconciledAt: '2026-09-24T10:00:00Z' });
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    view({ kind: 'indexing', indexedFolders: 0, totalFolders: null, files: 0 });
    expect(screen.getByRole('button', { name: /Indexing · 0 files so far/ })).toBeTruthy();
  });

  it.each([
    ['permission_lost', 'Soty lost access to the folder'],
    ['needs_reauth', 'Storage needs the owner to reconnect']
  ] as const)('shows an actionable %s state without erasing known items', (reason, label) => {
    render(
      <ToastProvider>
        <StorageChip
          teamId="team-1"
          health={{ kind: 'attention', reason, fixer: 'owner' }}
          client={{}}
          isOwner
          canManage
          settingsHref="/team/explorer?settings=1"
        />
      </ToastProvider>
    );
    expect(screen.getByRole('button', { name: label })).toBeTruthy();
  });

  it('shows a provider rate-limit as waiting rather than a failed scan', () => {
    render(
      <ToastProvider>
        <StorageChip
          teamId="team-1"
          health={{ kind: 'waiting_provider', since: '2026-09-24T10:00:00Z' }}
          client={{}}
          isOwner
          canManage
          settingsHref="/team/explorer?settings=1"
        />
      </ToastProvider>
    );
    expect(screen.getByRole('button', { name: 'Waiting for Google Drive…' })).toBeTruthy();
  });

  it.each([
    {
      coverage: 'partial' as const,
      syncHealth: 'failed' as const,
      nextAction: 'retry' as const,
      label: 'Storage was only partly checked',
      detail: 'Some accessible folders are still unchecked'
    },
    {
      coverage: 'complete' as const,
      syncHealth: 'delayed' as const,
      nextAction: 'wait' as const,
      label: 'Storage sync is delayed',
      detail: 'Accessible folders fully checked'
    }
  ])('shows $coverage coverage with $syncHealth status and last success', async scenario => {
    render(
      <ToastProvider>
        <StorageChip
          teamId="team-1"
          health={{
            kind: 'connected',
            lastReconciledAt: '2026-09-24T10:00:00Z',
            lastConfirmedAt: '2026-09-24T10:00:00Z',
            ...scenario
          }}
          client={{}}
          isOwner
          canManage
          settingsHref="/team/explorer?settings=1"
        />
      </ToastProvider>
    );
    await userEvent.click(screen.getByRole('button', { name: scenario.label }));
    expect(screen.getByText(scenario.detail)).toBeTruthy();
    expect(screen.getByText(/Last confirmed sync:/)).toBeTruthy();
  });
});
