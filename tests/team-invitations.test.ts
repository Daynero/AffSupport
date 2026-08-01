import { describe, expect, it, vi } from 'vitest';
import {
  buildInvitationEmail,
  sendInvitationEmail
} from '../supabase/functions/team-invitations/email';
import { executeInvitationCommand } from '../supabase/functions/team-invitations/handler';

describe('team invitation delivery', () => {
  it('builds a safe bilingual deep-link message without raw HTML injection', () => {
    const message = buildInvitationEmail({
      teamName: '<Wishly & Friends>',
      inviterName: 'Owner <script>',
      inviteUrl: 'https://wishly-app.pages.dev/account?invite=opaque-token'
    });
    expect(message.subject).toContain('Wishly');
    expect(message.html).toContain('&lt;Wishly &amp; Friends&gt;');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('https://wishly-app.pages.dev/account?invite=opaque-token');
    expect(message.text).not.toContain('<script>');
  });

  it('maps Resend provider success and failure to content-free delivery state', async () => {
    const fetchSuccess = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'provider-message-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    await expect(
      sendInvitationEmail(
        {
          apiKey: 'resend-test-secret',
          from: 'Wishly <team@example.test>',
          to: 'member@example.test',
          message: buildInvitationEmail({
            teamName: 'Media buyers',
            inviterName: 'Owner',
            inviteUrl: 'https://example.test/account?invite=opaque'
          })
        },
        fetchSuccess
      )
    ).resolves.toEqual({ state: 'sent', errorCode: null });

    const fetchFailure = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'raw provider body' }), { status: 503 })
      );
    await expect(
      sendInvitationEmail(
        {
          apiKey: 'resend-test-secret',
          from: 'Wishly <team@example.test>',
          to: 'member@example.test',
          message: buildInvitationEmail({
            teamName: 'Media buyers',
            inviterName: 'Owner',
            inviteUrl: 'https://example.test/account?invite=opaque'
          })
        },
        fetchFailure
      )
    ).resolves.toEqual({ state: 'failed', errorCode: 'DELIVERY_UNAVAILABLE' });
  });

  it('commits create before delivery and records delivery failure without losing the invite', async () => {
    const calls: string[] = [];
    const result = await executeInvitationCommand(
      {
        action: 'create',
        teamId: '20000000-0000-4000-8000-000000000001',
        email: 'member@example.test',
        initialRole: 'viewer',
        idempotencyKey: 'invite-attempt-01'
      },
      {
        createToken: () => 'opaque-invitation-token-00000001',
        rpc: async (name, parameters) => {
          calls.push(name);
          if (name === 'create_invitation') {
            expect(parameters).not.toHaveProperty('p_plain_token');
            return {
              ok: true,
              value: {
                id: '30000000-0000-4000-8000-000000000001',
                teamName: 'Media buyers',
                inviterName: 'Owner',
                targetEmail: 'member@example.test'
              }
            };
          }
          return { ok: true, value: true };
        },
        deliver: async () => {
          calls.push('deliver');
          return { state: 'failed', errorCode: 'DELIVERY_UNAVAILABLE' };
        },
        siteUrl: 'https://wishly-app.pages.dev'
      }
    );
    expect(calls).toEqual(['create_invitation', 'deliver', 'set_invitation_delivery_state']);
    expect(result).toMatchObject({
      invitationId: '30000000-0000-4000-8000-000000000001',
      deliveryState: 'failed',
      deliveryErrorCode: 'DELIVERY_UNAVAILABLE'
    });
  });

  it('rotates resend tokens and revokes without attempting delivery', async () => {
    const createToken = vi
      .fn()
      .mockReturnValueOnce('first-opaque-invitation-token')
      .mockReturnValueOnce('second-opaque-invitation-token');
    const rpc = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: '30000000-0000-4000-8000-000000000001',
        teamName: 'Media buyers',
        inviterName: 'Owner',
        targetEmail: 'member@example.test'
      }
    });
    const deliver = vi.fn().mockResolvedValue({ state: 'sent', errorCode: null });
    const deps = { rpc, deliver, createToken, siteUrl: 'https://wishly-app.pages.dev' };

    await executeInvitationCommand(
      {
        action: 'resend',
        invitationId: '30000000-0000-4000-8000-000000000001'
      },
      deps
    );
    await executeInvitationCommand(
      {
        action: 'revoke',
        invitationId: '30000000-0000-4000-8000-000000000001'
      },
      deps
    );

    expect(createToken).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.map(call => call[0])).toEqual([
      'resend_invitation',
      'set_invitation_delivery_state',
      'revoke_invitation'
    ]);
  });

  it.each(['accept', 'decline'] as const)(
    '%s forwards the optional deep-link token to the identity-checked RPC',
    async action => {
      const rpc = vi.fn().mockResolvedValue({
        ok: true,
        value:
          action === 'accept'
            ? {
                id: '20000000-0000-4000-8000-000000000001',
                name: 'Media buyers'
              }
            : { ok: true }
      });

      await executeInvitationCommand(
        {
          action,
          invitationId: '30000000-0000-4000-8000-000000000001',
          token: 'opaque-invitation-token'
        },
        {
          rpc,
          deliver: vi.fn(),
          createToken: vi.fn(),
          siteUrl: 'https://wishly-app.pages.dev'
        }
      );

      expect(rpc).toHaveBeenCalledWith(`${action}_invitation`, {
        p_invitation: '30000000-0000-4000-8000-000000000001',
        p_plain_token: 'opaque-invitation-token'
      });
    }
  );

  it('does not let a valid token substitute for the caller confirmed email', async () => {
    const rpc = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'PERMISSION_DENIED', retryable: false }
    });

    await expect(
      executeInvitationCommand(
        {
          action: 'accept',
          invitationId: '30000000-0000-4000-8000-000000000001',
          token: 'valid-token-for-a-different-confirmed-email'
        },
        {
          rpc,
          deliver: vi.fn(),
          createToken: vi.fn(),
          siteUrl: 'https://wishly-app.pages.dev'
        }
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', retryable: false });
  });
});
