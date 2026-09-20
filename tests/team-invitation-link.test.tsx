// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamApiError } from '../apps/web/src/api/team';
import {
  InvitationPanel,
  type InvitationPanelClient
} from '../apps/web/src/team/members/InvitationPanel';
import { ToastProvider } from '../apps/web/src/components/toast';

const TEAM_ID = '21000000-0000-4000-8000-000000000001';
const LINK = 'http://127.0.0.1:5175/team/invitations/abc?token=secret';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeClient(extra: Record<string, unknown> = {}): InvitationPanelClient {
  return {
    listInvitations: vi.fn().mockResolvedValue([]),
    createInvitation: vi.fn().mockResolvedValue({
      id: 'invitation-1',
      targetEmail: 'teammate@example.test',
      state: 'pending',
      deliveryState: 'failed',
      deliveryErrorCode: 'DELIVERY_UNAVAILABLE',
      expiresAt: '2026-09-01T10:00:00.000Z',
      ...extra
    })
  } as unknown as InvitationPanelClient;
}

async function invite(client: InvitationPanelClient) {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <InvitationPanel teamId={TEAM_ID} client={client} canManage />
    </ToastProvider>
  );
  await user.type(await screen.findByLabelText('Invite by email'), 'teammate@example.test');
  await user.click(screen.getByRole('button', { name: 'Send invitation' }));
  return user;
}

describe('invitation link fallback', () => {
  it('shows the link when the environment returns one instead of delivering mail', async () => {
    // Without this the invitation is a dead end: the row says "Delivery failed"
    // and nothing anywhere hands over the link the server already issued.
    await invite(makeClient({ inviteUrl: LINK }));

    const field = (await screen.findByLabelText('Invitation link')) as HTMLInputElement;
    expect(field.value).toBe(LINK);
    expect(
      screen.getByText(
        'This environment does not send invitation mail. Copy this link and give it to the person yourself.'
      )
    ).toBeTruthy();
  });

  it('copies the link and confirms it', async () => {
    const user = await invite(makeClient({ inviteUrl: LINK }));
    // userEvent.setup() installs its own clipboard stub, so replace it after.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeTruthy();
  });

  it('shows no link when the environment delivered the invitation itself', async () => {
    // Production must never print an acceptance token into the inviter's screen.
    await invite(makeClient({ deliveryState: 'sent', deliveryErrorCode: null }));

    await screen.findByText('teammate@example.test');
    expect(screen.queryByLabelText('Invitation link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  });

  it('names why an invitation was refused instead of blaming delivery', async () => {
    const client = {
      listInvitations: vi.fn().mockResolvedValue([]),
      createInvitation: vi.fn().mockRejectedValue(new TeamApiError('ALREADY_INVITED', false))
    } as unknown as InvitationPanelClient;
    await invite(client);

    expect(
      await screen.findByText('This email already has a pending invitation to this space.')
    ).toBeTruthy();
    expect(screen.queryByText('Delivery failed')).toBeNull();
  });
});

describe('an invitation row', () => {
  function row(state: string, extra: Record<string, unknown> = {}) {
    return {
      id: `invitation-${state}`,
      targetEmail: `${state}@example.test`,
      state,
      deliveryState: 'sent',
      deliveryErrorCode: null,
      expiresAt: '2026-09-01T10:00:00.000Z',
      initialRole: 'viewer',
      ...extra
    };
  }

  it('says its own state in a word, and offers only what that state allows', async () => {
    // FR-063 and the row's calm (024): a revoked invitation used to read "Sent"
    // and still carried Resend and Revoke; a pending one carried both as bordered
    // buttons. A word for every state, and one menu while there is anything to do.
    const user = userEvent.setup();
    const client = {
      listInvitations: vi.fn().mockResolvedValue([row('pending'), row('revoked'), row('expired')]),
      resendInvitation: vi.fn().mockResolvedValue(undefined),
      revokeInvitation: vi.fn().mockResolvedValue(undefined)
    } as unknown as InvitationPanelClient;
    render(
      <ToastProvider>
        <InvitationPanel teamId={TEAM_ID} client={client} canManage />
      </ToastProvider>
    );

    expect(await screen.findByText('Revoked')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More for revoked@example.test' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'More for pending@example.test' }));
    expect(await screen.findByRole('menuitem', { name: 'Resend' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'Revoke' }));
    // The question names who it is about (024).
    expect(
      await screen.findByRole('heading', {
        name: 'Revoke the invitation for pending@example.test?'
      })
    ).toBeTruthy();
  });
});
