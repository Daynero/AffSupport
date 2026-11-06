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
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { analytics } from '../apps/web/src/analytics/service';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TrashView, type TrashViewClient } from '../apps/web/src/team/catalog/TrashView';
import { useMaterialActions } from '../apps/web/src/team/catalog/useMaterialActions';
import type { MaterialActionsClient } from '../apps/web/src/team/catalog/material-actions-client';
import { translate } from '../apps/web/src/i18n';
import { clickMaterialAction, openMaterialActions } from './support/material-surface';

/**
 * US5 — friction proportional to risk.
 *
 * The findings behind these: a task could be created but never deleted (R1),
 * trashing was a one-way trip with a confirmation in front of it (R2), and the
 * confirmations that did exist asked "are you sure?" instead of naming what
 * would happen (R3).
 */

const TEAM_ID = '20000000-0000-4000-8000-000000000001';

beforeEach(() => {
  localStorage.clear();
  setPrivateCacheScope('47000000-0000-4000-8000-000000000081', 'restore-owner');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setPrivateCacheScope(null, 'restore-ended');
});

const permissions = {
  view: true,
  download: true,
  upload: true,
  edit: true,
  delete: true,
  process: true,
  manage_members: false,
  manage_metadata: false
};

const material = {
  id: '47000000-0000-4000-8000-000000000091',
  teamId: TEAM_ID,
  name: 'launch.mp4',
  kind: 'file' as const,
  fileExtension: 'mp4',
  sizeBytes: 1024
};

function actionsClient(): MaterialActionsClient {
  return {
    uploadFile: vi.fn(),
    requestDownload: vi.fn(),
    downloadWithAgent: vi.fn(),
    renameMaterial: vi.fn(),
    moveMaterial: vi.fn(),
    trashMaterial: vi.fn().mockResolvedValue({
      operationId: 'op',
      state: 'succeeded',
      materialId: material.id,
      reused: false
    }),
    restoreMaterial: vi.fn().mockResolvedValue({
      operationId: 'op',
      state: 'succeeded',
      materialId: material.id,
      reused: false
    })
  };
}

async function openMenu(client: MaterialActionsClient) {
  await openMaterialActions({
    teamId: TEAM_ID,
    material,
    permissions,
    client,
    browseClient: { listMaterials: vi.fn().mockResolvedValue([]) },
    onChanged: vi.fn()
  });
}

describe('trashing a file', () => {
  it('keeps Undo usable after confirmed deletion unmounts its original row', async () => {
    const client = actionsClient();
    function Row({ removed }: { removed: () => void }) {
      const actions = useMaterialActions({ teamId: TEAM_ID, material, client, onChanged: removed });
      return <button onClick={() => void actions.trash()}>Trash row</button>;
    }
    function Workspace() {
      const [visible, setVisible] = React.useState(true);
      return <ToastProvider>{visible && <Row removed={() => setVisible(false)} />}</ToastProvider>;
    }
    render(<Workspace />);
    await userEvent.click(screen.getByRole('button', { name: 'Trash row' }));
    await screen.findByText('Moved to trash');
    expect(screen.queryByRole('button', { name: 'Trash row' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Restored')).toBeTruthy();
    expect(client.restoreMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedActorId: '47000000-0000-4000-8000-000000000081'
      })
    );
  });

  it('clears retired-scope busy state without accepting its late restore feedback', async () => {
    const client = actionsClient();
    let finish!: (value: Awaited<ReturnType<MaterialActionsClient['restoreMaterial']>>) => void;
    vi.mocked(client.restoreMaterial).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    );
    const hook = renderHook(
      () => useMaterialActions({ teamId: TEAM_ID, material, client, onChanged: vi.fn() }),
      { wrapper }
    );
    let pending!: Promise<string | null>;
    act(() => {
      pending = hook.result.current.restore();
    });
    expect(hook.result.current.busy).toBe(true);
    await act(async () => {
      setPrivateCacheScope('47000000-0000-4000-8000-000000000082', 'replacement');
    });
    hook.rerender();
    expect(hook.result.current.busy).toBe(false);
    await act(async () => {
      finish({ operationId: 'op', state: 'succeeded', materialId: material.id, reused: false });
      await pending;
    });
    expect(screen.queryByText('Restored')).toBeNull();
  });

  it('bounds an unknown Undo reply and ignores late success without replacing its request identity', async () => {
    vi.useFakeTimers();
    const client = actionsClient();
    let finish!: (value: Awaited<ReturnType<MaterialActionsClient['restoreMaterial']>>) => void;
    vi.mocked(client.restoreMaterial).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    );
    const hook = renderHook(
      () => useMaterialActions({ teamId: TEAM_ID, material, client, onChanged: vi.fn() }),
      { wrapper }
    );
    let pending!: Promise<string | null>;
    act(() => {
      pending = hook.result.current.restore();
    });
    const key = vi.mocked(client.restoreMaterial).mock.calls[0][0].idempotencyKey;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001);
    });
    expect(await pending).toBe('PROCESS_RESULT_UNCERTAIN');
    await act(async () => {
      finish({ operationId: 'op', state: 'succeeded', materialId: material.id, reused: false });
    });
    expect(screen.queryByText('Restored')).toBeNull();
    await act(async () => {
      await hook.result.current.restore();
    });
    expect(client.restoreMaterial).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyKey: key })
    );
  });

  it('retains the same restore request across remount after a lost acknowledgement', async () => {
    const client = actionsClient();
    vi.mocked(client.restoreMaterial).mockRejectedValueOnce(new Error('DRIVE_UNAVAILABLE'));
    const input = { teamId: TEAM_ID, material, client, onChanged: vi.fn() };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    );
    const first = renderHook(() => useMaterialActions(input), { wrapper });
    await act(async () => {
      await first.result.current.restore();
    });
    const key = vi.mocked(client.restoreMaterial).mock.calls[0][0].idempotencyKey;
    first.unmount();
    const reopened = renderHook(() => useMaterialActions(input), { wrapper });
    await act(async () => {
      await reopened.result.current.restore();
    });
    expect(client.restoreMaterial).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: key,
        expectedActorId: '47000000-0000-4000-8000-000000000081'
      })
    );
  });

  it('asks nothing and offers Undo instead', async () => {
    const client = actionsClient();
    await openMenu(client);

    await clickMaterialAction('Move to trash');
    // No dialog stood between the press and the action.
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(client.trashMaterial).toHaveBeenCalledOnce());
    expect(await screen.findByText('Moved to trash')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('restores on Undo, with its own idempotency key', async () => {
    const client = actionsClient();
    await openMenu(client);

    await clickMaterialAction('Move to trash');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(client.restoreMaterial).toHaveBeenCalledOnce());
    const trashKey = vi.mocked(client.trashMaterial).mock.calls[0]?.[0].idempotencyKey;
    const restoreKey = vi.mocked(client.restoreMaterial).mock.calls[0]?.[0].idempotencyKey;
    expect(restoreKey).not.toBe(trashKey);
    expect(await screen.findByText('Restored')).toBeTruthy();
  });

  it('is a one-shot affordance — the Undo goes once it is taken', async () => {
    const client = actionsClient();
    await openMenu(client);

    await clickMaterialAction('Move to trash');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
  });

  it('does not execute a retained Undo as a replacement account', async () => {
    const client = actionsClient();
    await openMenu(client);
    await clickMaterialAction('Move to trash');
    const undo = await screen.findByRole('button', { name: 'Undo' });
    act(() => setPrivateCacheScope('47000000-0000-4000-8000-000000000082', 'replacement'));
    await userEvent.click(undo);
    expect(client.restoreMaterial).not.toHaveBeenCalled();
    expect(screen.queryByText('Restored')).toBeNull();
  });

  it('keeps the original actor on Undo and suppresses a late result after account replacement', async () => {
    const client = actionsClient();
    let finish!: (value: Awaited<ReturnType<MaterialActionsClient['restoreMaterial']>>) => void;
    vi.mocked(client.restoreMaterial).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    await openMenu(client);
    await clickMaterialAction('Move to trash');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(client.restoreMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedActorId: '47000000-0000-4000-8000-000000000081'
      })
    );
    act(() => setPrivateCacheScope('47000000-0000-4000-8000-000000000082', 'replacement'));
    await act(async () =>
      finish({ operationId: 'op', state: 'succeeded', materialId: material.id, reused: false })
    );
    expect(screen.queryByText('Restored')).toBeNull();
  });

  it('says what went wrong when the undo loses a race', async () => {
    const client = actionsClient();
    vi.mocked(client.restoreMaterial).mockRejectedValue(new Error('NOT_FOUND'));
    await openMenu(client);

    await clickMaterialAction('Move to trash');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(
      await screen.findByText('That is no longer here — someone may have moved or removed it.')
    ).toBeTruthy();
  });
});

it.each(['pending', 'running', 'failed', 'canceled'])(
  'does not show restored after an Undo receipt in state %s',
  async state => {
    const client = actionsClient();
    vi.mocked(client.restoreMaterial).mockResolvedValue({
      operationId: 'restore-op',
      state,
      materialId: material.id,
      reused: false
    } as never);
    await openMenu(client);
    await clickMaterialAction('Move to trash');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(client.restoreMaterial).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('Restored')).toBeNull();
    expect(screen.getByText(translate('en', 'teamErrorProcessResultUncertain'))).toBeTruthy();
  }
);

describe('the trash view', () => {
  function trashClient(): TrashViewClient {
    return {
      listTrashedMaterials: vi.fn().mockResolvedValue([
        {
          id: '47000000-0000-4000-8000-000000000091',
          name: 'launch.mp4',
          kind: 'file' as const,
          trashedAt: '2026-08-20T10:00:00.000Z',
          parentPathHint: 'Campaign'
        }
      ]),
      restoreMaterial: vi.fn().mockResolvedValue({
        operationId: 'op',
        state: 'succeeded',
        materialId: '47000000-0000-4000-8000-000000000091',
        reused: false
      })
    };
  }

  it('lists what was trashed, where it was, and how long it stays restorable', async () => {
    const client = trashClient();
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );

    expect(await screen.findByText('launch.mp4')).toBeTruthy();
    expect(screen.getByText('Campaign')).toBeTruthy();
    // Honest about whose retention rule actually applies.
    expect(screen.getByText(/Google Drive trash/)).toBeTruthy();
  });

  it('continues a page through tied trash timestamps using the last material identity', async () => {
    const client = trashClient();
    const page = Array.from({ length: 50 }, (_, index) => ({
      id: '47000000-0000-4000-8000-' + String(100 + index).padStart(12, '0'),
      name: 'same-time-' + index + '.mp4',
      kind: 'file' as const,
      trashedAt: '2026-08-20T10:00:00.000001Z',
      parentPathHint: null
    }));
    vi.mocked(client.listTrashedMaterials).mockResolvedValueOnce(page).mockResolvedValueOnce([]);
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );
    await screen.findByText('same-time-49.mp4');
    await userEvent.click(
      screen.getByRole('button', { name: translate('en', 'teamTrashLoadMore') })
    );
    await waitFor(() =>
      expect(client.listTrashedMaterials).toHaveBeenLastCalledWith(
        expect.objectContaining({ before: page[49].trashedAt, beforeId: page[49].id })
      )
    );
  });

  it('restores a row and takes it off the list', async () => {
    const client = trashClient();
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(client.restoreMaterial).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: TEAM_ID,
          materialId: '47000000-0000-4000-8000-000000000091'
        })
      )
    );
    expect(await screen.findByText('Restored')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('launch.mp4')).toBeNull());
  });

  it.each(['pending', 'running', 'failed', 'canceled'])(
    'keeps the row and never reports restoration for a %s operation',
    async state => {
      const client = trashClient();
      vi.mocked(client.restoreMaterial).mockResolvedValue({
        operationId: 'op',
        state,
        materialId: '47000000-0000-4000-8000-000000000091',
        reused: false
      });
      render(
        <ToastProvider>
          <TrashView teamId={TEAM_ID} client={client} />
        </ToastProvider>
      );
      await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
      await waitFor(() => expect(client.restoreMaterial).toHaveBeenCalledOnce());
      expect(screen.queryByText('Restored')).toBeNull();
      expect(screen.getByText('launch.mp4')).toBeTruthy();
    }
  );
  it('retains the original restoration key after a lost acknowledgement', async () => {
    const client = trashClient();
    vi.mocked(client.restoreMaterial)
      .mockRejectedValueOnce(new TypeError('reply lost'))
      .mockResolvedValueOnce({
        operationId: 'op',
        state: 'succeeded',
        materialId: '47000000-0000-4000-8000-000000000091',
        reused: false
      });
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(client.restoreMaterial).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(client.restoreMaterial).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(client.restoreMaterial).mock.calls;
    expect(calls[1]![0].idempotencyKey).toBe(calls[0]![0].idempotencyKey);
    expect(await screen.findByText('Restored')).toBeTruthy();
  });

  it('retains an unknown restore identity across closing and reopening the bin', async () => {
    const client = trashClient();
    vi.mocked(client.restoreMaterial).mockRejectedValue(new TypeError('reply lost'));
    const first = render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(client.restoreMaterial).toHaveBeenCalledOnce());
    first.unmount();
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(client.restoreMaterial).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(client.restoreMaterial).mock.calls;
    expect(calls[1]![0].idempotencyKey).toBe(calls[0]![0].idempotencyKey);
  });

  it('refuses a stale Restore click before account-change cleanup', async () => {
    const client = trashClient();
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );
    const button = await screen.findByRole('button', { name: 'Restore' });
    act(() => {
      setPrivateCacheScope('47000000-0000-4000-8000-000000000082', 'restore-replaced');
      fireEvent.click(button);
    });
    await act(async () => {});
    expect(client.restoreMaterial).not.toHaveBeenCalled();
  });
  it('does not deliver an old restore result to the replacement account', async () => {
    const client = trashClient();
    let finish!: (value: unknown) => void;
    vi.mocked(client.restoreMaterial).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await act(async () => {
      setPrivateCacheScope('47000000-0000-4000-8000-000000000082', 'restore-replaced');
    });
    await act(async () => {
      finish({
        operationId: 'op',
        state: 'succeeded',
        materialId: '47000000-0000-4000-8000-000000000091',
        reused: false
      });
    });
    expect(screen.queryByText('Restored')).toBeNull();
    expect(await screen.findByText('launch.mp4')).toBeTruthy();
  });
  it('ignores a late page from the replaced trash client', async () => {
    const previous = trashClient(),
      current = trashClient();
    let finish!: (value: Awaited<ReturnType<TrashViewClient['listTrashedMaterials']>>) => void;
    vi.mocked(previous.listTrashedMaterials).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    vi.mocked(current.listTrashedMaterials).mockResolvedValue([
      {
        id: 'new',
        name: 'Current catalog',
        kind: 'file',
        trashedAt: '2026-11-05T10:00:00Z',
        parentPathHint: null
      }
    ]);
    const view = render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={previous} />
      </ToastProvider>
    );
    await waitFor(() => expect(previous.listTrashedMaterials).toHaveBeenCalledOnce());
    view.rerender(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={current} />
      </ToastProvider>
    );
    await screen.findByText('Current catalog');
    await act(async () => {
      finish([
        {
          id: 'old',
          name: 'Old catalog',
          kind: 'file',
          trashedAt: '2026-11-05T10:00:00Z',
          parentPathHint: null
        }
      ]);
    });
    expect(screen.getByText('Current catalog')).toBeTruthy();
    expect(screen.queryByText('Old catalog')).toBeNull();
  });

  it('bounds a stalled trash read and retries reading without restoring a file', async () => {
    vi.useFakeTimers();
    const client = trashClient();
    vi.mocked(client.listTrashedMaterials).mockImplementationOnce(() => new Promise(() => {}));
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(screen.getByText('Could not load the trash. Try again.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: translate('en', 'retry') }));
    });
    expect(client.listTrashedMaterials).toHaveBeenCalledTimes(2);
    expect(screen.getByText('launch.mp4')).toBeTruthy();
    expect(client.restoreMaterial).not.toHaveBeenCalled();
  });

  it('releases a stalled restore wait and ignores its late reply while retaining the original key', async () => {
    vi.useFakeTimers();
    const client = trashClient();
    let finish!: (value: unknown) => void;
    vi.mocked(client.restoreMaterial).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    vi.mocked(client.restoreMaterial).mockRejectedValueOnce(new TypeError('still unavailable'));
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(screen.getByRole('button', { name: 'Restore' }).hasAttribute('disabled')).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    });
    expect(client.restoreMaterial).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(client.restoreMaterial).mock.calls;
    expect(calls[1]![0].idempotencyKey).toBe(calls[0]![0].idempotencyKey);
    await act(async () => {
      finish({
        operationId: 'op',
        state: 'succeeded',
        materialId: '47000000-0000-4000-8000-000000000091',
        reused: false
      });
    });
    expect(screen.getByText('launch.mp4')).toBeTruthy();
    expect(screen.queryByText('Restored')).toBeNull();
  });

  it('delivers restore success only with the committed feedback for its hosted operation', async () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    const client = trashClient();
    let finish!: (value: unknown) => void;
    vi.mocked(client.restoreMaterial).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const events = () =>
      track.mock.calls.filter(
        ([, p]) => p && 'flow_step' in p && p.flow_step === 'workspace_restore'
      );
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(events().filter(([event]) => event === 'operation_started')).toHaveLength(1);
    expect(events().some(([event]) => event === 'operation_completed')).toBe(false);
    const operation = '47000000-0000-4000-8000-000000000099';
    await act(async () => {
      finish({
        operationId: operation,
        state: 'succeeded',
        materialId: '47000000-0000-4000-8000-000000000091',
        reused: false
      });
    });
    expect(screen.getByText('Restored')).toBeTruthy();
    expect(events().filter(([event]) => event === 'operation_completed')).toEqual([
      [
        'operation_completed',
        expect.objectContaining({ run_id: operation, action_identifier: 'result_visible' })
      ]
    ]);
    expect(JSON.stringify(events())).not.toContain('launch.mp4');
  });
  it('keeps unknown restore feedback open and reconciles the same intent on retry', async () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    const client = trashClient(),
      operation = '47000000-0000-4000-8000-000000000099';
    vi.mocked(client.restoreMaterial)
      .mockResolvedValueOnce({
        operationId: operation,
        state: 'running',
        materialId: null,
        reused: false
      })
      .mockResolvedValueOnce({
        operationId: operation,
        state: 'succeeded',
        materialId: '47000000-0000-4000-8000-000000000091',
        reused: true
      });
    const events = () =>
      track.mock.calls.filter(
        ([, p]) => p && 'flow_step' in p && p.flow_step === 'workspace_restore'
      );
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(events().some(([event]) => event === 'operation_completed')).toBe(false);
    expect(
      events().some(
        ([event, p]) =>
          event === 'operation_stage_completed' &&
          p &&
          'action_identifier' in p &&
          p.action_identifier === 'result_visible'
      )
    ).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(events().filter(([event]) => event === 'operation_started')).toHaveLength(1);
    expect(events().filter(([event]) => event === 'operation_completed')).toHaveLength(1);
    const calls = vi.mocked(client.restoreMaterial).mock.calls;
    expect(calls[0]![0].idempotencyKey).toBe(calls[1]![0].idempotencyKey);
  });

  it('says so when the trash cannot be read', async () => {
    const client = trashClient();
    vi.mocked(client.listTrashedMaterials).mockRejectedValue(new Error('PERMISSION_DENIED'));
    render(
      <ToastProvider>
        <TrashView teamId={TEAM_ID} client={client} />
      </ToastProvider>
    );

    expect(await screen.findByText('Could not load the trash. Try again.')).toBeTruthy();
  });
});

describe('confirmations name their consequence', () => {
  /**
   * A confirmation that only asks "are you sure?" gives the reader nothing to
   * be sure *about*. Each of these has to say what actually happens.
   */
  it.each([
    ['teamLeaveConfirmBody', 'lose access'],
    ['teamTaskDeleteConfirmBody', 'not deleted'],
    ['teamDriveDetachConfirmBody', 'Nothing is deleted'],
    ['teamInvitationRevokeConfirmBody', 'stops working'],
    ['teamDraftDeleteConfirmBody', 'nothing is stored in it']
  ] as const)('%s states an outcome', (key, fragment) => {
    const copy = translate('en', key);
    expect(copy).toContain(fragment);
    expect(copy.toLowerCase()).not.toContain('are you sure');
  });
});
