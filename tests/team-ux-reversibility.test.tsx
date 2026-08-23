// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import { MaterialRowMenu } from '../apps/web/src/team/catalog/MaterialRowMenu';
import { TrashView, type TrashViewClient } from '../apps/web/src/team/catalog/TrashView';
import type { MaterialActionsClient } from '../apps/web/src/team/catalog/material-actions-client';
import { translate } from '../apps/web/src/i18n';

/**
 * US5 — friction proportional to risk.
 *
 * The findings behind these: a task could be created but never deleted (R1),
 * trashing was a one-way trip with a confirmation in front of it (R2), and the
 * confirmations that did exist asked "are you sure?" instead of naming what
 * would happen (R3).
 */

const TEAM_ID = '20000000-0000-4000-8000-000000000001';

afterEach(() => {
  vi.restoreAllMocks();
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
  id: 'material-1',
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
    trashMaterial: vi.fn().mockResolvedValue({ operationId: 'op', state: 'succeeded' }),
    restoreMaterial: vi.fn().mockResolvedValue({ operationId: 'op', state: 'succeeded' })
  };
}

async function openMenu(client: MaterialActionsClient) {
  render(
    <ToastProvider>
      <MaterialRowMenu
        teamId={TEAM_ID}
        material={material}
        permissions={permissions}
        client={client}
        browseClient={{ listMaterials: vi.fn().mockResolvedValue([]) }}
        onChanged={vi.fn()}
      />
    </ToastProvider>
  );
  await userEvent.click(screen.getByRole('button', { name: 'Actions for launch.mp4' }));
}

describe('trashing a file', () => {
  it('asks nothing and offers Undo instead', async () => {
    const client = actionsClient();
    await openMenu(client);

    await userEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    // No dialog stood between the press and the action.
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(client.trashMaterial).toHaveBeenCalledOnce());
    expect(await screen.findByText('Moved to trash')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('restores on Undo, with its own idempotency key', async () => {
    const client = actionsClient();
    await openMenu(client);

    await userEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
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

    await userEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
  });

  it('says what went wrong when the undo loses a race', async () => {
    const client = actionsClient();
    vi.mocked(client.restoreMaterial).mockRejectedValue(new Error('NOT_FOUND'));
    await openMenu(client);

    await userEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(
      await screen.findByText('That is no longer here — someone may have moved or removed it.')
    ).toBeTruthy();
  });
});

describe('the trash view', () => {
  function trashClient(): TrashViewClient {
    return {
      listTrashedMaterials: vi.fn().mockResolvedValue([
        {
          id: 'material-1',
          name: 'launch.mp4',
          kind: 'file' as const,
          trashedAt: '2026-08-20T10:00:00.000Z',
          parentPathHint: 'Campaign'
        }
      ]),
      restoreMaterial: vi.fn().mockResolvedValue({ operationId: 'op', state: 'succeeded' })
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
        expect.objectContaining({ teamId: TEAM_ID, materialId: 'material-1' })
      )
    );
    expect(await screen.findByText('Restored')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('launch.mp4')).toBeNull());
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
