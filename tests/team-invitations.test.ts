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
      inviteUrl: 'https://soty.pp.ua/account?invite=opaque-token'
    });
    expect(message.subject).toContain('Wishly');
    expect(message.html).toContain('&lt;Wishly &amp; Friends&gt;');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('https://soty.pp.ua/account?invite=opaque-token');
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
        siteUrl: 'https://soty.pp.ua'
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
    const deps = { rpc, deliver, createToken, siteUrl: 'https://soty.pp.ua' };

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
          siteUrl: 'https://soty.pp.ua'
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
          siteUrl: 'https://soty.pp.ua'
        }
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', retryable: false });
  });

  it('directly adds a confirmed Wishly account only after the caller-scoped lookup gate', async () => {
    const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
    const deliver = vi.fn();
    const createToken = vi.fn();
    const member = {
      membership_id: '31000000-0000-4000-8000-000000000001',
      user_id: '10000000-0000-4000-8000-000000000002',
      display_name: 'Registered Member',
      email: 'member@example.test',
      role: 'viewer',
      base_role: 'viewer',
      permission_overrides: {},
      effective_permissions: {
        view: true,
        download: true,
        upload: false,
        edit: false,
        delete: false,
        process: false,
        manage_members: false,
        manage_metadata: false
      },
      joined_at: '2026-08-02T10:00:00.000Z'
    };

    await expect(
      executeInvitationCommand(
        {
          action: 'direct-add',
          teamId: '20000000-0000-4000-8000-000000000001',
          email: ' MEMBER@EXAMPLE.TEST ',
          initialRole: 'viewer'
        },
        {
          actorId: '10000000-0000-4000-8000-000000000001',
          directAddMode: 'testing',
          rpc: async (name, parameters) => {
            calls.push({ name, parameters });
            if (name === 'lookup_invitable_account') {
              return {
                ok: true,
                value: [
                  {
                    user_id: member.user_id,
                    confirmed_email: member.email,
                    display_name: member.display_name
                  }
                ]
              };
            }
            return { ok: true, value: [member] };
          },
          deliver,
          createToken,
          siteUrl: 'https://soty.pp.ua'
        }
      )
    ).resolves.toEqual([member]);

    expect(calls).toEqual([
      {
        name: 'lookup_invitable_account',
        parameters: {
          p_team: '20000000-0000-4000-8000-000000000001',
          p_email: ' MEMBER@EXAMPLE.TEST '
        }
      },
      {
        name: 'service_direct_add_registered_member',
        parameters: {
          p_actor: '10000000-0000-4000-8000-000000000001',
          p_team: '20000000-0000-4000-8000-000000000001',
          p_email: ' MEMBER@EXAMPLE.TEST ',
          p_base_role: 'viewer'
        }
      }
    ]);
    expect(deliver).not.toHaveBeenCalled();
    expect(createToken).not.toHaveBeenCalled();
  });

  it('fails closed when direct-add testing mode is disabled or the account lookup is empty', async () => {
    const disabledRpc = vi.fn();
    await expect(
      executeInvitationCommand(
        {
          action: 'direct-add',
          teamId: '20000000-0000-4000-8000-000000000001',
          email: 'member@example.test',
          initialRole: 'viewer'
        },
        {
          actorId: '10000000-0000-4000-8000-000000000001',
          directAddMode: 'disabled',
          rpc: disabledRpc,
          deliver: vi.fn(),
          createToken: vi.fn(),
          siteUrl: 'https://soty.pp.ua'
        }
      )
    ).rejects.toMatchObject({ code: 'WRONG_STATE', retryable: false });
    expect(disabledRpc).not.toHaveBeenCalled();

    const missingRpc = vi.fn().mockResolvedValue({ ok: true, value: [] });
    await expect(
      executeInvitationCommand(
        {
          action: 'direct-add',
          teamId: '20000000-0000-4000-8000-000000000001',
          email: 'missing@example.test',
          initialRole: 'editor'
        },
        {
          actorId: '10000000-0000-4000-8000-000000000001',
          directAddMode: 'testing',
          rpc: missingRpc,
          deliver: vi.fn(),
          createToken: vi.fn(),
          siteUrl: 'https://soty.pp.ua'
        }
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(missingRpc).toHaveBeenCalledTimes(1);
  });
});
