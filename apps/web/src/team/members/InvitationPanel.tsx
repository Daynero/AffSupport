import { useEffect, useState, type FormEvent } from 'react';
import type { TeamBaseRole } from '@video-compressor/shared';
import type { TeamInvitationSummary } from '../../api/team';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui';

export interface InvitationPanelClient {
  listInvitations: (teamId: string) => Promise<TeamInvitationSummary[]>;
  createInvitation: (input: {
    teamId: string;
    email: string;
    initialRole?: TeamBaseRole;
  }) => Promise<
    Pick<TeamInvitationSummary, 'id' | 'targetEmail' | 'state' | 'deliveryState' | 'expiresAt'> &
      Partial<TeamInvitationSummary>
  >;
  resendInvitation?: (invitationId: string) => Promise<TeamInvitationSummary>;
  revokeInvitation?: (invitationId: string) => Promise<void>;
}

function normalizedInvitation(
  value: Awaited<ReturnType<InvitationPanelClient['createInvitation']>>,
  role: TeamBaseRole
): TeamInvitationSummary {
  return {
    initialRole: role,
    deliveryErrorCode: null,
    ...value
  };
}

export function InvitationPanel({
  teamId,
  client,
  canManage,
  revision = 0,
  onChanged
}: {
  teamId: string;
  client: InvitationPanelClient;
  canManage: boolean;
  revision?: number;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamBaseRole>('viewer');
  const [invitations, setInvitations] = useState<TeamInvitationSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .listInvitations(teamId)
      .then(value => {
        if (active) setInvitations(value);
      })
      .catch(() => {
        if (active) setError(t('teamLoadFailed'));
      });
    return () => {
      active = false;
    };
  }, [client, revision, t, teamId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLocaleLowerCase('en-US');
    if (!normalizedEmail.includes('@') || normalizedEmail.length > 320) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = normalizedInvitation(
        await client.createInvitation({ teamId, email: normalizedEmail, initialRole: role }),
        role
      );
      setInvitations(current => [created, ...current.filter(item => item.id !== created.id)]);
      setEmail('');
      onChanged?.();
    } catch {
      setError(t('teamInvitationFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async (invitationId: string) => {
    if (!client.resendInvitation) return;
    const updated = await client.resendInvitation(invitationId);
    setInvitations(current => current.map(item => (item.id === invitationId ? updated : item)));
    onChanged?.();
  };

  const revoke = async (invitationId: string) => {
    if (!client.revokeInvitation) return;
    await client.revokeInvitation(invitationId);
    setInvitations(current =>
      current.map(item => (item.id === invitationId ? { ...item, state: 'revoked' } : item))
    );
    onChanged?.();
  };

  return (
    <section className="team-panel team-invitations" aria-labelledby="team-invitations-title">
      <h2 id="team-invitations-title">{t('teamMembers')}</h2>
      {canManage && (
        <form className="team-invite-form" onSubmit={event => void submit(event)}>
          <label>
            <span>{t('teamInviteEmail')}</span>
            <input
              type="email"
              value={email}
              maxLength={320}
              onChange={event => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>{t('teamInviteRole')}</span>
            <select value={role} onChange={event => setRole(event.target.value as TeamBaseRole)}>
              <option value="admin">{t('teamRoleAdmin')}</option>
              <option value="editor">{t('teamRoleEditor')}</option>
              <option value="viewer">{t('teamRoleViewer')}</option>
            </select>
          </label>
          <Button type="submit" variant="primary" loading={submitting} disabled={!email.trim()}>
            {t('teamInviteSend')}
          </Button>
        </form>
      )}
      {error && <p className="team-inline-error">{error}</p>}
      <ul className="team-invitation-list">
        {invitations.map(invitation => (
          <li key={invitation.id}>
            <span>{invitation.targetEmail}</span>
            <span className={`team-delivery-state is-${invitation.deliveryState}`}>
              {invitation.deliveryState === 'sent'
                ? t('teamInvitationSent')
                : invitation.deliveryState === 'failed'
                  ? t('teamInvitationFailed')
                  : t('teamInvitationPending')}
            </span>
            {invitation.state === 'pending' && client.resendInvitation && (
              <Button type="button" variant="ghost" onClick={() => void resend(invitation.id)}>
                {t('teamInvitationResend')}
              </Button>
            )}
            {invitation.state === 'pending' && client.revokeInvitation && (
              <Button type="button" variant="ghost" onClick={() => void revoke(invitation.id)}>
                {t('teamInvitationRevoke')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
