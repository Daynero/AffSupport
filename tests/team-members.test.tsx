// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type {
  TeamAuditEventSummary,
  TeamContextSnapshot,
  TeamMemberSummary
} from '../apps/web/src/api/team';
import { TeamProvider, useTeam } from '../apps/web/src/team/TeamContext';
import { ToastProvider } from '../apps/web/src/components/toast';
import { MemberList, type MemberManagementClient } from '../apps/web/src/team/members/MemberList';
import {
  MembersSection,
  type MembersSectionClient
} from '../apps/web/src/team/workspace/MembersSection';
import { TeamAuditPanel } from '../apps/web/src/team/members/TeamAuditPanel';

const TEAM_ID = '21000000-0000-4000-8000-000000000001';
const OWNER_ID = '11000000-0000-4000-8000-000000000001';
const MEMBER_ID = '11000000-0000-4000-8000-000000000002';

const team: TeamContextSnapshot = {
  id: TEAM_ID,
  name: 'Permissions team',
  role: 'owner',
  permissions: DEFAULT_ROLE_PERMISSIONS.owner,
  connectionState: 'connected'
};

const owner: TeamMemberSummary = {
  membershipId: '31000000-0000-4000-8000-000000000001',
  userId: OWNER_ID,
  displayName: 'Owner User',
  email: 'owner@example.test',
  role: 'owner',
  baseRole: 'admin',
  permissionOverrides: {},
  effectivePermissions: DEFAULT_ROLE_PERMISSIONS.owner,
  joinedAt: '2026-08-01T10:00:00.000Z'
};

const editor: TeamMemberSummary = {
  membershipId: '31000000-0000-4000-8000-000000000002',
  userId: MEMBER_ID,
  displayName: 'Alex Editor',
  email: 'alex@example.test',
  role: 'editor',
  baseRole: 'editor',
  permissionOverrides: {},
  effectivePermissions: DEFAULT_ROLE_PERMISSIONS.editor,
  joinedAt: '2026-08-01T11:00:00.000Z'
};

beforeEach(() => {
  // Enter the space explicitly; the workspace no longer auto-selects teams[0].
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function renderMembers(client: MemberManagementClient) {
  return render(
    <TeamProvider initialTeams={[team]} realtime={false}>
      <ToastProvider>
        <MemberList teamId={TEAM_ID} client={client} />
      </ToastProvider>
    </TeamProvider>
  );
}

describe('team membership management', () => {
  it('edits sparse permissions with edit and metadata visibly independent', async () => {
    const client: MemberManagementClient = {
      listMembers: vi.fn().mockResolvedValue([owner, editor]),
      updateMembership: vi.fn().mockResolvedValue({
        ...editor,
        permissionOverrides: { edit: false },
        effectivePermissions: { ...editor.effectivePermissions, edit: false }
      }),
      removeMember: vi.fn(),
      transferOwnership: vi.fn()
    };
    const user = userEvent.setup();
    renderMembers(client);

    expect(await screen.findByText('Alex Editor')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Edit permissions for Alex Editor' }));

    const edit = screen.getByRole('checkbox', { name: 'Edit space content' });
    const metadata = screen.getByRole('checkbox', { name: 'File details and shared settings' });
    expect((edit as HTMLInputElement).checked).toBe(true);
    expect((metadata as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByText('Edit space content'));
    expect((edit as HTMLInputElement).checked).toBe(false);
    expect((metadata as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));

    await waitFor(() =>
      expect(client.updateMembership).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        userId: MEMBER_ID,
        baseRole: 'editor',
        permissionOverrides: { edit: false }
      })
    );
  });

  it('requires confirmation for removal and ownership transfer and shows the Drive warning', async () => {
    const client: MemberManagementClient = {
      listMembers: vi.fn().mockResolvedValue([owner, editor]),
      updateMembership: vi.fn(),
      removeMember: vi.fn().mockResolvedValue({
        ok: true,
        warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS'
      }),
      transferOwnership: vi.fn().mockResolvedValue({ ...team, role: 'editor' })
    };
    const user = userEvent.setup();
    renderMembers(client);
    expect(await screen.findByText('Alex Editor')).toBeTruthy();

    // Rare and heavy, so behind "…" (024, FR-097).
    await user.click(screen.getByRole('button', { name: 'More for Alex Editor' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Transfer ownership' }));
    await user.selectOptions(screen.getByLabelText('Your new role'), 'editor');
    await user.click(screen.getByLabelText('I understand that Alex Editor will become owner'));
    await user.click(screen.getByRole('button', { name: 'Transfer ownership' }));
    await waitFor(() =>
      expect(client.transferOwnership).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        toUserId: MEMBER_ID,
        demoteTo: 'editor'
      })
    );

    await user.click(screen.getByRole('button', { name: 'More for Alex Editor' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from space' }));
    expect(screen.getByText(/direct Google Drive access is managed separately/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove member' }));
    await waitFor(() => expect(client.removeMember).toHaveBeenCalledWith(TEAM_ID, MEMBER_ID));
  });

  it('renders only the safe owner/admin audit projection', async () => {
    const events: TeamAuditEventSummary[] = [
      {
        id: '41000000-0000-4000-8000-000000000001',
        actorLabel: 'Owner User',
        action: 'membership.updated',
        target: { role: 'editor' },
        result: 'succeeded',
        errorCode: null,
        occurredAt: '2026-08-01T12:00:00.000Z',
        subjectLabel: null
      }
    ];
    const client = { listAuditEvents: vi.fn().mockResolvedValue(events) };
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <TeamAuditPanel teamId={TEAM_ID} client={client} />
      </TeamProvider>
    );

    // The history is read by people, so it says what happened; the stored
    // identifier and the role token behind it never reach the page.
    expect(await screen.findByText('Member role changed')).toBeTruthy();
    expect(screen.getByText('Editor')).toBeTruthy();
    expect(screen.queryByText('membership.updated')).toBeNull();
    expect(screen.getByText('Owner User')).toBeTruthy();
    expect(screen.getByText('Succeeded')).toBeTruthy();
    expect(screen.queryByText(/41000000-/)).toBeNull();
  });
});

it('never reports zero members while loading and offers retry after a failed read', async () => {
  let reject!: (error: unknown) => void;
  const client: MemberManagementClient = {
    listMembers: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          })
      )
      .mockResolvedValueOnce([owner, editor]),
    updateMembership: vi.fn(),
    removeMember: vi.fn(),
    transferOwnership: vi.fn()
  };
  const user = userEvent.setup();
  renderMembers(client);
  expect(screen.queryByText('0 members')).toBeNull();
  expect(screen.getAllByText('Loading members…').length).toBeGreaterThan(0);
  reject(new Error('unavailable'));
  await user.click(await screen.findByRole('button', { name: 'Repeat' }));
  expect(await screen.findByText('Alex Editor')).toBeTruthy();
  expect(screen.getByText('2 members')).toBeTruthy();
});

it('prevents duplicate removal and closing the confirmation while the request is pending', async () => {
  let resolve!: (value: { ok: true; warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS' }) => void;
  const client: MemberManagementClient = {
    listMembers: vi.fn().mockResolvedValue([owner, editor]),
    updateMembership: vi.fn(),
    transferOwnership: vi.fn(),
    removeMember: vi.fn(
      () =>
        new Promise<{ ok: true; warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS' }>(done => {
          resolve = done;
        })
    )
  };
  const user = userEvent.setup();
  renderMembers(client);
  await user.click(await screen.findByRole('button', { name: 'More for Alex Editor' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Remove from space' }));
  const button = screen.getByRole('button', { name: 'Remove member' });
  await user.dblClick(button);
  expect(client.removeMember).toHaveBeenCalledOnce();
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog', { name: 'Remove member' })).toBeTruthy();
  resolve({ ok: true, warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS' });
  await waitFor(() => expect(screen.queryByText('Alex Editor')).toBeNull());
});

it('explains restricted membership access without querying private member or invitation data', () => {
  const client: MembersSectionClient = {
    listMembers: vi.fn(),
    updateMembership: vi.fn(),
    removeMember: vi.fn(),
    transferOwnership: vi.fn(),
    listInvitations: vi.fn(),
    createInvitation: vi.fn(),
    leaveTeam: vi.fn()
  };
  render(
    <TeamProvider
      initialTeams={[{ ...team, role: 'viewer', permissions: DEFAULT_ROLE_PERMISSIONS.viewer }]}
      realtime={false}
    >
      <ToastProvider>
        <MembersSection teamId={TEAM_ID} client={client} />
      </ToastProvider>
    </TeamProvider>
  );
  expect(
    screen.getByText(
      /Viewing the member list and changing access requires member management permission/
    )
  ).toBeTruthy();
  expect(client.listMembers).not.toHaveBeenCalled();
  expect(client.listInvitations).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Edit permissions/ })).toBeNull();
});

it('refreshes members and invitations when the workspace receives a remote revision', async () => {
  const client: MembersSectionClient = {
    listMembers: vi.fn().mockResolvedValueOnce([owner]).mockResolvedValue([owner, editor]),
    updateMembership: vi.fn(),
    removeMember: vi.fn(),
    transferOwnership: vi.fn(),
    listInvitations: vi.fn().mockResolvedValue([]),
    createInvitation: vi.fn(),
    leaveTeam: vi.fn()
  };
  function RemoteChange() {
    const { notifyStateChanged } = useTeam();
    return <button onClick={notifyStateChanged}>Remote membership changed</button>;
  }
  const user = userEvent.setup();
  render(
    <TeamProvider initialTeams={[team]} realtime={false}>
      <ToastProvider>
        <RemoteChange />
        <MembersSection teamId={TEAM_ID} client={client} />
      </ToastProvider>
    </TeamProvider>
  );
  await screen.findByText('Owner User');
  await waitFor(() => expect(client.listInvitations).toHaveBeenCalledOnce());
  await user.click(screen.getByRole('button', { name: 'Remote membership changed' }));
  await waitFor(() => expect(client.listMembers).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Alex Editor')).toBeTruthy();
  expect(client.listInvitations).toHaveBeenCalledTimes(2);
});
