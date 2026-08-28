// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamApi, type TeamInvitationSummary } from '../apps/web/src/api/team';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('guided team space workspace', () => {
  it('enters a space content-first and keeps management behind space settings', async () => {
    const team = makeTeam();
    const invitations: TeamInvitationSummary[] = [];
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([team]),
      // The explorer reads paged rows from the index (011).
      listFolderPage: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'material-visible',
            teamId: team.id,
            name: 'launch.mp4',
            category: 'video',
            mimeType: 'video/mp4',
            fileExtension: 'mp4',
            sizeBytes: 1024,
            kind: 'video',
            driveFileId: 'drive-visible',
            parentFolderId: 'root',
            modifiedAt: null,
            driveVersion: '1',
            previewState: 'pending',
            thumbnailReady: false
          }
        ],
        total: 1,
        next: null
      }),
      listInvitations: vi.fn().mockImplementation(async () => [...invitations]),
      createInvitation: vi.fn().mockImplementation(async () => {
        const created = {
          id: '30000000-0000-4000-8000-000000000001',
          targetEmail: 'new.member@example.test',
          state: 'pending' as const,
          deliveryState: 'sent' as const,
          expiresAt: '2026-08-15T12:00:00.000Z',
          initialRole: 'viewer' as const,
          deliveryErrorCode: null
        };
        invitations.push(created);
        return created;
      })
    });
    const user = userEvent.setup();

    render(
      <TeamProvider realtime={false}>
        <TeamSpace client={client} directAddMode="disabled" />
      </TeamProvider>
    );

    // One ready space is not a choice: the resolver enters it directly, and the
    // content-first shell shows the folder without a lobby step (FR-005).
    expect(await screen.findByText('launch.mp4')).toBeTruthy();
    const previewMaterial = vi.spyOn(teamApi, 'previewMaterial').mockResolvedValue({
      kind: 'media',
      rangeUrl: 'https://preview.example/launch.mp4',
      mimeType: 'video/mp4',
      expiresAt: '2026-08-15T12:00:00.000Z'
    });
    await user.click(screen.getByRole('button', { name: 'Open launch.mp4' }));
    expect(await screen.findByRole('dialog', { name: 'launch.mp4' })).toBeTruthy();
    await waitFor(() =>
      expect(previewMaterial).toHaveBeenCalledWith(team.id, 'material-visible', 'media')
    );
    await user.click(screen.getByRole('button', { name: 'Close preview' }));
    // The old all-panels grid is gone: management is not shown beside the content.
    expect(screen.queryByRole('heading', { name: 'Google Drive storage' })).toBeNull();

    // Management lives behind a single "Space settings" entry — a link now, so
    // it is addressable and can be opened in a new tab.
    await user.click(screen.getByRole('link', { name: 'Space settings' }));
    await user.type(await screen.findByLabelText('Invite by email'), 'new.member@example.test');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('new.member@example.test')).toBeTruthy();

    // Return to the content view. The opened file is still selected, so its name
    // shows on the tile and in the pane (011).
    await user.click(screen.getByRole('button', { name: 'Back to space' }));
    expect((await screen.findAllByText('launch.mp4')).length).toBeGreaterThanOrEqual(1);

    await waitFor(() =>
      expect(client.createInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: team.id, email: 'new.member@example.test' })
      )
    );
  });
});
