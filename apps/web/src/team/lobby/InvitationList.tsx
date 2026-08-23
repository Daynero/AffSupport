import { useCallback, useEffect, useState } from 'react';
import type { TeamInvitationSummary } from '../../api/team';
import { teamApi, TeamApiError } from '../../api/team';
import { Button } from '../../components/ui';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { buildTeamRoute } from '../routes';
import { teamErrorMessage } from '../errors';

export interface InvitationListClient {
  listMyInvitations: () => Promise<TeamInvitationSummary[]>;
  acceptInvitation: (invitationId: string, token?: string) => Promise<unknown>;
  declineInvitation: (invitationId: string, token?: string) => Promise<unknown>;
}

const defaultClient: InvitationListClient = teamApi;

function roleLabelKey(role: TeamInvitationSummary['initialRole']) {
  if (role === 'admin') return 'teamRoleAdmin' as const;
  if (role === 'editor') return 'teamRoleEditor' as const;
  return 'teamRoleViewer' as const;
}

/**
 * The invitations waiting for an answer, wherever they need to be shown.
 *
 * Invitations used to live only on the account page, which is not where anyone
 * looks for a space they have been invited to — so they went unanswered
 * (finding I1). This is rendered at the top of the lobby *and* reused on the
 * account page, so there is one implementation of accept/decline rather than
 * two that can drift.
 */
export function InvitationList({
  client = defaultClient,
  /** Invitation opened from a link, whose token authorizes the response. */
  linkedInvitationId = null,
  linkedToken,
  onAnswered,
  /** Hide the whole block when there is nothing to answer (lobby). */
  hideWhenEmpty = false,
  headingId
}: {
  client?: InvitationListClient;
  linkedInvitationId?: string | null;
  linkedToken?: string;
  onAnswered?: () => void;
  hideWhenEmpty?: boolean;
  headingId: string;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [invitations, setInvitations] = useState<TeamInvitationSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .listMyInvitations()
      .then(value => {
        if (active) setInvitations(value.filter(invitation => invitation.state === 'pending'));
      })
      .catch(() => {
        // An unavailable team RPC must not take the surrounding page with it.
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [client]);

  const respond = useCallback(
    async (invitation: TeamInvitationSummary, action: 'accept' | 'decline') => {
      setBusyId(invitation.id);
      const token = invitation.id === linkedInvitationId ? linkedToken : undefined;
      try {
        if (action === 'accept') {
          await client.acceptInvitation(invitation.id, token);
          setInvitations(current => current.filter(item => item.id !== invitation.id));
          push({ tone: 'success', text: t('teamToastInvitationAccepted') });
          onAnswered?.();
          // Straight into the space when we know which one it is; otherwise the
          // resolver decides, which is also what shows a still-preparing space.
          navigateTo(invitation.teamId ? buildTeamRoute({ spaceId: invitation.teamId }) : '/team');
        } else {
          await client.declineInvitation(invitation.id, token);
          setInvitations(current => current.filter(item => item.id !== invitation.id));
          push({ tone: 'info', text: t('teamToastInvitationDeclined') });
          onAnswered?.();
        }
      } catch (cause) {
        const code = cause instanceof TeamApiError ? cause.code : null;
        push({
          tone: 'error',
          // A denied response usually means the invitation was addressed to a
          // different account, which is worth saying plainly.
          text:
            code === 'PERMISSION_DENIED'
              ? t('teamInvitationIdentityError')
              : teamErrorMessage(code, t)
        });
      } finally {
        setBusyId(null);
      }
    },
    [client, linkedInvitationId, linkedToken, onAnswered, push, t]
  );

  if (hideWhenEmpty && (!loaded || invitations.length === 0) && !linkedInvitationId) return null;

  return (
    <section className="team-invitation-inbox" aria-labelledby={headingId}>
      <h3 id={headingId}>{t('teamInvitationInbox')}</h3>
      {loaded && invitations.length === 0 && <p>{t('teamInvitationEmpty')}</p>}
      <ul>
        {invitations.map(invitation => (
          <li key={invitation.id}>
            <div className="team-invitation-identity">
              <strong>{invitation.teamName ?? t('teamInvitationUnknownSpace')}</strong>
              <span>
                {t('teamInvitationFromAs', {
                  inviter: invitation.inviterName ?? t('teamInvitationUnknownInviter'),
                  role: t(roleLabelKey(invitation.initialRole))
                })}
              </span>
            </div>
            <div className="team-inline-actions">
              <Button
                variant="primary"
                loading={busyId === invitation.id}
                onClick={() => void respond(invitation, 'accept')}
              >
                {t('teamInvitationAccept')}
              </Button>
              <Button
                variant="ghost"
                disabled={busyId === invitation.id}
                onClick={() => void respond(invitation, 'decline')}
              >
                {t('teamInvitationDecline')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
