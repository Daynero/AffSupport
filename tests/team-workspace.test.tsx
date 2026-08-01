// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { TeamInvitationSummary } from '../apps/web/src/api/team';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  TeamWorkspacePage,
  type TeamWorkspaceClient
} from '../apps/web/src/team/TeamWorkspacePage';

const archiveTeam = {
  id: '20000000-0000-4000-8000-000000000001',
  name: 'Archive team',
  role: 'owner' as const,
  permissions: DEFAULT_ROLE_PERMISSIONS.owner,
  connectionState: 'none' as const
};

const createdTeam = {
  id: '20000000-0000-4000-8000-000000000002',
  name: 'Media buyers',
  role: 'owner' as const,
  permissions: DEFAULT_ROLE_PERMISSIONS.owner,
  connectionState: 'none' as const
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('team workspace onboarding journey', () => {
  it('creates, switches, invites, connects, and browses without rendering another team', async () => {
    const invitations: TeamInvitationSummary[] = [];
    const client: TeamWorkspaceClient = {
      listTeams: vi.fn().mockResolvedValue([archiveTeam]),
      createTeam: vi.fn().mockResolvedValue(createdTeam),
      listMembers: vi.fn().mockResolvedValue([]),
      updateMembership: vi.fn(),
      removeMember: vi.fn(),
      transferOwnership: vi.fn(),
      listAuditEvents: vi.fn().mockResolvedValue([]),
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
      }),
      getConnectionStatus: vi.fn().mockResolvedValue({ state: 'none' }),
      listFolders: vi.fn().mockResolvedValue({
        folders: [{ id: 'root-folder', name: 'Team media', driveKind: 'my_drive' as const }],
        nextPageToken: null
      }),
      confirmDriveRoot: vi
        .fn()
        .mockResolvedValueOnce({
          state: 'confirmation_required',
          folder: { id: 'root-folder', name: 'Team media', driveKind: 'my_drive' as const },
          account: 'owner@example.test',
          independentAclWarning: true
        })
        .mockResolvedValueOnce({
          state: 'connected',
          folder: { id: 'root-folder', name: 'Team media', driveKind: 'my_drive' as const },
          syncState: 'queued'
        }),
      listMaterials: vi.fn().mockResolvedValue([
        {
          id: 'material-visible',
          teamId: createdTeam.id,
          name: 'launch.mp4',
          kind: 'file',
          category: 'video'
        }
      ]),
      searchCatalog: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        activeFilters: {},
        facets: {},
        catalogFreshness: { state: 'not_started', lastSyncedAt: null }
      }),
      getCatalogVocabulary: vi.fn().mockResolvedValue({
        geo: [],
        languages: [],
        offers: [],
        tags: []
      }),
      updateMaterialMetadata: vi.fn()
    };
    const user = userEvent.setup();

    render(
      <TeamProvider realtime={false}>
        <TeamWorkspacePage client={client} />
      </TeamProvider>
    );

    expect(await screen.findByRole('option', { name: 'Archive team' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create team' }));
    await user.type(screen.getByLabelText('Team name'), 'Media buyers');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('option', { name: 'Media buyers' })).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Active team'), archiveTeam.id);
    expect(screen.getByRole('heading', { name: 'Archive team' })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Active team'), createdTeam.id);
    expect(screen.getByRole('heading', { name: 'Media buyers' })).toBeTruthy();

    await user.type(screen.getByLabelText('Invite by email'), 'new.member@example.test');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('new.member@example.test')).toBeTruthy();
    expect(screen.getByText('Sent')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));
    await user.click(await screen.findByRole('button', { name: 'Team media' }));
    expect(await screen.findByText('owner@example.test')).toBeTruthy();
    expect(screen.getByText(/independent.*Google Drive permissions/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm folder' }));

    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(await screen.findByText('launch.mp4')).toBeTruthy();
    expect(screen.queryByText('Secret competitor creative')).toBeNull();

    await waitFor(() => {
      expect(client.createTeam).toHaveBeenCalledWith('Media buyers');
      expect(client.createInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: createdTeam.id, email: 'new.member@example.test' })
      );
      expect(client.confirmDriveRoot).toHaveBeenLastCalledWith(
        expect.objectContaining({
          teamId: createdTeam.id,
          folderId: 'root-folder',
          confirmed: true
        })
      );
      expect(client.listMaterials).toHaveBeenCalledWith(createdTeam.id, null);
    });
  });

  it('removes a no-longer-visible active team and never exposes its cached catalog', async () => {
    localStorage.setItem('wishly.active-team.v1', '20000000-0000-4000-8000-000000000099');
    const client: TeamWorkspaceClient = {
      listTeams: vi.fn().mockResolvedValue([archiveTeam]),
      createTeam: vi.fn(),
      listMembers: vi.fn().mockResolvedValue([]),
      updateMembership: vi.fn(),
      removeMember: vi.fn(),
      transferOwnership: vi.fn(),
      listAuditEvents: vi.fn().mockResolvedValue([]),
      listInvitations: vi.fn().mockResolvedValue([]),
      createInvitation: vi.fn(),
      getConnectionStatus: vi.fn().mockResolvedValue({ state: 'none' }),
      listFolders: vi.fn(),
      confirmDriveRoot: vi.fn(),
      listMaterials: vi.fn().mockResolvedValue([]),
      searchCatalog: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        activeFilters: {},
        facets: {},
        catalogFreshness: { state: 'not_started', lastSyncedAt: null }
      }),
      getCatalogVocabulary: vi.fn().mockResolvedValue({
        geo: [],
        languages: [],
        offers: [],
        tags: []
      }),
      updateMaterialMetadata: vi.fn()
    };

    render(
      <TeamProvider realtime={false}>
        <TeamWorkspacePage client={client} />
      </TeamProvider>
    );

    expect(await screen.findByRole('heading', { name: 'Archive team' })).toBeTruthy();
    expect(screen.queryByText('Removed team material')).toBeNull();
    await waitFor(() => expect(localStorage.getItem('wishly.active-team.v1')).toBe(archiveTeam.id));
  });
});
