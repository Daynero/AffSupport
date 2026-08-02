// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { TeamApiError } from '../apps/web/src/api/team';
import { InvitationPanel } from '../apps/web/src/team/members/InvitationPanel';

const TEAM_ID = '20000000-0000-4000-8000-000000000001';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('temporary registered-member direct add', () => {
  it('adds an existing Wishly account immediately without creating an invitation', async () => {
    const onChanged = vi.fn();
    const directAddMember = vi.fn().mockResolvedValue({
      membershipId: '31000000-0000-4000-8000-000000000001',
      userId: '10000000-0000-4000-8000-000000000002',
      displayName: 'Registered Member',
      email: 'member@example.test',
      role: 'editor',
      baseRole: 'editor',
      permissionOverrides: {},
      effectivePermissions: DEFAULT_ROLE_PERMISSIONS.editor,
      joinedAt: '2026-08-02T10:00:00.000Z'
    });
    const createInvitation = vi.fn();
    const user = userEvent.setup();

    render(
      <InvitationPanel
        teamId={TEAM_ID}
        canManage
        directAddMode="testing"
        onChanged={onChanged}
        client={{
          listInvitations: vi.fn().mockResolvedValue([]),
          createInvitation,
          directAddMember
        }}
      />
    );

    expect(screen.getByText(/test mode/i)).toBeTruthy();
    await user.type(screen.getByLabelText('Registered Wishly email'), ' MEMBER@EXAMPLE.TEST ');
    await user.selectOptions(screen.getByLabelText('Initial role'), 'editor');
    await user.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() =>
      expect(directAddMember).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        email: 'member@example.test',
        initialRole: 'editor'
      })
    );
    expect(createInvitation).not.toHaveBeenCalled();
    expect(await screen.findByText('Member added to the team.')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows that no registered Wishly account exists for an unknown email', async () => {
    const user = userEvent.setup();
    render(
      <InvitationPanel
        teamId={TEAM_ID}
        canManage
        directAddMode="testing"
        client={{
          listInvitations: vi.fn().mockResolvedValue([]),
          createInvitation: vi.fn(),
          directAddMember: vi.fn().mockRejectedValue(new TeamApiError('NOT_FOUND', false))
        }}
      />
    );

    await user.type(screen.getByLabelText('Registered Wishly email'), 'missing@example.test');
    await user.click(screen.getByRole('button', { name: 'Add member' }));

    expect(
      await screen.findByText('No registered Wishly user was found for this email.')
    ).toBeTruthy();
  });
});
