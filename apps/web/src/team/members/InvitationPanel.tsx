import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Info, UserPlus } from 'lucide-react';
import type { TeamBaseRole, TeamTariff } from '@video-compressor/shared';
import { TeamApiError, type TeamInvitationSummary, type TeamMemberSummary } from '../../api/team';
import { useI18n, type TranslationKey } from '../../i18n';
import { useToasts } from '../../components/toast';
import { useOptionalAuth } from '../../auth/AuthContext';
import { teamErrorMessageFor } from '../errors';
import { useOptionalTeam } from '../TeamContext';
import { ContactAdminButton } from '../tariffs/ContactAdminButton';
import { planName, pluralForm } from '../tariffs/format';
import { useOptionalSpaceAccess } from '../tariffs/useSpaceAccess';
import { Alert, Button, FormField, Input, Select, Tooltip } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { SettingsSection } from '../workspace/SettingsSection';
import { MemberRowMenu } from './MemberList';

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
  directAddMember?: (input: {
    teamId: string;
    email: string;
    initialRole?: TeamBaseRole;
  }) => Promise<TeamMemberSummary>;
  resendInvitation?: (invitationId: string) => Promise<TeamInvitationSummary>;
  revokeInvitation?: (invitationId: string) => Promise<void>;
  /** 034 — the space's seats; absent (or failing) means no counter, as before tariffs. */
  getTeamTariff?: (teamId: string) => Promise<TeamTariff>;
}

/** States in which seats are a limit people see; the old rule and internal spaces have none. */
const SEATED_STATES = new Set<TeamTariff['state']>(['active', 'expiring', 'grace']);

const INVITE_ROLES: readonly TeamBaseRole[] = ['admin', 'editor', 'viewer'];
const ROLE_LABEL = {
  admin: 'teamRoleAdmin',
  editor: 'teamRoleEditor',
  viewer: 'teamRoleViewer'
} as const satisfies Partial<Record<TeamBaseRole, TranslationKey>>;
const ROLE_DESCRIPTION = {
  admin: 'teamRoleAdminDescription',
  editor: 'teamRoleEditorDescription',
  viewer: 'teamRoleViewerDescription'
} as const satisfies Partial<Record<TeamBaseRole, TranslationKey>>;

/**
 * The role the last invitation from this browser used, for this space (024). The one invited is
 * usually the same kind of person as the last — a designer, then another designer — and the
 * picker used to reset to Viewer, which a designer cannot work with. Editor when nothing is kept.
 */
const roleKey = (teamId: string) => `soty.inviteRole.${teamId}`;
function rememberedRole(teamId: string): TeamBaseRole {
  try {
    const kept = localStorage.getItem(roleKey(teamId));
    return INVITE_ROLES.includes(kept as TeamBaseRole) ? (kept as TeamBaseRole) : 'editor';
  } catch {
    return 'editor';
  }
}
function rememberRole(teamId: string, role: TeamBaseRole) {
  try {
    localStorage.setItem(roleKey(teamId), role);
  } catch {
    // A private window keeps nothing; the next invitation starts at Editor.
  }
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
  directAddMode = 'disabled',
  revision = 0,
  onChanged
}: {
  teamId: string;
  client: InvitationPanelClient;
  canManage: boolean;
  directAddMode?: 'disabled' | 'testing';
  revision?: number;
  onChanged?: () => void;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const revokeTitleId = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamBaseRole>(() => rememberedRole(teamId));
  const emailId = useId();
  const roleId = useId();
  const [invitations, setInvitations] = useState<TeamInvitationSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const directAdd = directAddMode === 'testing';
  const listId = useId();

  /* 034 — seats (US4.1–4.2). Read from the server, never counted here. */
  const auth = useOptionalAuth();
  const team = useOptionalTeam();
  const spaceAccess = useOptionalSpaceAccess();
  const [tariff, setTariff] = useState<TeamTariff | null>(null);
  const loadTariff = useCallback(() => {
    if (!client.getTeamTariff) return;
    void client
      .getTeamTariff(teamId)
      .then(setTariff)
      .catch(() => setTariff(null));
  }, [client, teamId]);
  useEffect(() => {
    loadTariff();
  }, [loadTariff, revision]);
  const seated = tariff !== null && SEATED_STATES.has(tariff.state) && tariff.seatsTotal > 0;
  const seatsFull = seated && tariff.seatsUsed >= tariff.seatsTotal;
  const soloPlan = seated && !tariff.canInvite;
  const spaceName =
    team?.teams.find(item => item.id === teamId)?.name ?? team?.activeTeam?.name ?? '';
  const myEmail = spaceAccess?.access?.showcase?.email || auth?.user?.email || '';
  const contact = spaceAccess?.access?.showcase?.contact;
  const pendingIds = invitations.filter(item => item.state === 'pending').map(item => item.id);

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
    setSuccess(null);
    setInviteUrl(null);
    try {
      if (directAdd) {
        if (!client.directAddMember) {
          throw new TeamApiError('WRONG_STATE', false);
        }
        rememberRole(teamId, role);
        await client.directAddMember({ teamId, email: normalizedEmail, initialRole: role });
        setSuccess(t('teamDirectAddSucceeded'));
      } else {
        rememberRole(teamId, role);
        const created = normalizedInvitation(
          await client.createInvitation({ teamId, email: normalizedEmail, initialRole: role }),
          role
        );
        setInvitations(current => [created, ...current.filter(item => item.id !== created.id)]);
        // An environment that does not deliver invitation mail hands the link
        // back instead. Showing it is the difference between "delivery failed"
        // being a dead end and the invitation flow staying walkable.
        setInviteUrl(created.inviteUrl ?? null);
        setLinkCopied(false);
      }
      setEmail('');
      loadTariff();
      onChanged?.();
    } catch (caught) {
      if (directAdd && caught instanceof TeamApiError) {
        if (caught.code === 'NOT_FOUND') setError(t('teamDirectAddNotFound'));
        else if (caught.code === 'ALREADY_MEMBER') setError(t('teamDirectAddAlreadyMember'));
        else if (caught.code === 'TEAM_MEMBER_LIMIT') setError(t('teamDirectAddLimit'));
        else if (caught.code === 'WRONG_STATE') setError(t('teamDirectAddDisabled'));
        else setError(t('teamDirectAddFailed'));
      } else if (caught instanceof TeamApiError) {
        // The server already distinguishes why an invitation was refused. Saying
        // "Delivery failed" for all of them is doubly wrong: it names the wrong
        // cause, and no delivery was even attempted.
        if (caught.code === 'SEATS_FULL') {
          setError(t('tariffErrorSeatsFull'));
          loadTariff();
        } else if (caught.code === 'ALREADY_INVITED') setError(t('teamInviteAlreadyInvited'));
        else if (caught.code === 'ALREADY_MEMBER') setError(t('teamInviteAlreadyMember'));
        else if (caught.code === 'TEAM_MEMBER_LIMIT') setError(t('teamInviteLimit'));
        else if (caught.code === 'PERMISSION_DENIED' || caught.code === 'NOT_A_MEMBER')
          setError(t('teamInviteNotAllowed'));
        else setError(t('teamInviteCreateFailed'));
      } else {
        setError(directAdd ? t('teamDirectAddFailed') : t('teamInviteCreateFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Both of these used to be unguarded awaits behind `void`: a rejection became
  // an unhandled promise and the row simply never changed (finding S3).
  const resend = async (invitationId: string) => {
    if (!client.resendInvitation) return;
    try {
      const updated = await client.resendInvitation(invitationId);
      setInvitations(current => current.map(item => (item.id === invitationId ? updated : item)));
      // Where mail is not delivered the link comes back; show it, as a new invitation does.
      if (updated.inviteUrl) {
        setInviteUrl(updated.inviteUrl);
        setLinkCopied(false);
      }
      push({ tone: 'success', text: t('teamToastInvitationResent') });
      onChanged?.();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    }
  };

  const revoke = async (invitationId: string) => {
    if (!client.revokeInvitation) return;
    try {
      await client.revokeInvitation(invitationId);
      setInvitations(current =>
        current.map(item => (item.id === invitationId ? { ...item, state: 'revoked' } : item))
      );
      push({ tone: 'success', text: t('teamToastInvitationRevoked') });
      loadTariff();
      onChanged?.();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    }
  };

  return (
    <SettingsSection
      icon={UserPlus}
      titleId="team-invitations-title"
      title={directAdd ? t('teamDirectAddTitle') : t('teamInviteTitle')}
      className="team-invitations"
    >
      {directAdd && canManage && <p className="team-test-mode-note">{t('teamDirectAddNote')}</p>}
      {seated && tariff && (
        <p className="tariff-seat-counter text-caption text-ink-muted">
          <span>
            {t('tariffSeatsCounter', { used: tariff.seatsUsed, total: tariff.seatsTotal })}
            {tariff.pendingInvites > 0 &&
              ` · ${t(
                pluralForm(language, tariff.pendingInvites, {
                  one: 'tariffSeatsPendingOne',
                  few: 'tariffSeatsPendingFew',
                  many: 'tariffSeatsPendingMany'
                }),
                { count: tariff.pendingInvites }
              )}`}
          </span>
          <Tooltip label={t('tariffSeatsHint')}>
            <Info
              size={ICON_SIZE - 4}
              strokeWidth={ICON_STROKE}
              aria-label={t('tariffSeatsHint')}
            />
          </Tooltip>
        </p>
      )}
      {canManage && seated && tariff && (soloPlan || seatsFull) && (
        <Alert
          color="neutral"
          variant="subtle"
          className="tariff-seats-full"
          action={
            <div className="flex flex-wrap gap-2">
              {!soloPlan && pendingIds.length > 0 && client.revokeInvitation && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (pendingIds.length === 1) setConfirmingRevoke(pendingIds[0]!);
                    else document.getElementById(listId)?.scrollIntoView({ block: 'nearest' });
                  }}
                >
                  {t('teamInvitationRevoke')}
                </Button>
              )}
              <ContactAdminButton
                contact={contact}
                size="sm"
                color="neutral"
                variant="outline"
                icon={false}
                label={soloPlan ? undefined : t('tariffSeatsAsk')}
                subject={t('tariffMessageSubject')}
                message={
                  soloPlan
                    ? t('tariffMessageTogether', { space: spaceName, email: myEmail })
                    : t('tariffMessageSeat', { space: spaceName, email: myEmail })
                }
              />
            </div>
          }
        >
          {soloPlan
            ? t('tariffInviteSolo', { plan: planName(tariff, language) })
            : t('tariffSeatsFull', { total: tariff.seatsTotal })}
        </Alert>
      )}
      {canManage && !(seated && (soloPlan || seatsFull)) && (
        <form className="team-invite-form" onSubmit={event => void submit(event)}>
          <FormField
            label={directAdd ? t('teamDirectAddEmail') : t('teamInviteEmail')}
            htmlFor={emailId}
          >
            <Input
              id={emailId}
              type="email"
              value={email}
              maxLength={320}
              onChange={event => setEmail(event.target.value)}
            />
          </FormField>
          <FormField label={<span id={roleId}>{t('teamInviteRole')}</span>}>
            <Select
              aria-labelledby={roleId}
              value={role}
              options={INVITE_ROLES.map(value => ({ value, label: t(ROLE_LABEL[value]) }))}
              onChange={next => setRole(next as TeamBaseRole)}
            />
          </FormField>
          <Button type="submit" variant="primary" loading={submitting} disabled={!email.trim()}>
            {directAdd ? t('teamDirectAddSubmit') : t('teamInviteSend')}
          </Button>
          {/* What the chosen role may do, said where it is chosen (024). */}
          <p className="team-invite-role-hint">{t(ROLE_DESCRIPTION[role])}</p>
        </form>
      )}
      {error && (
        <p className="team-inline-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="team-inline-success" role="status">
          {success}
        </p>
      )}
      {inviteUrl && (
        <div className="team-invitation-link" role="status">
          <strong>{t('teamInvitationLinkTitle')}</strong>
          <p>{t('teamInvitationLinkHint')}</p>
          <input type="text" readOnly value={inviteUrl} aria-label={t('teamInvitationLinkTitle')} />
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(inviteUrl).then(
                () => setLinkCopied(true),
                () => setLinkCopied(false)
              );
            }}
          >
            {linkCopied ? t('teamInvitationLinkCopied') : t('teamInvitationLinkCopy')}
          </Button>
        </div>
      )}
      <ul className="team-invitation-list" id={listId}>
        {invitations.map(invitation => (
          <li key={invitation.id}>
            {/* Email, its state in one word, and one menu (024, benchmarked on
                Linear's member invitations): the row used to carry a coloured
                badge and two bordered buttons, and the second wrapped onto a line
                of its own. A revoked, accepted or expired invitation says so and
                offers nothing (FR-063). */}
            <span className="team-invitation-email">{invitation.targetEmail}</span>
            <span
              className={`team-delivery-state is-${
                invitation.state === 'pending' ? invitation.deliveryState : invitation.state
              } ui-color-${
                invitation.state !== 'pending'
                  ? 'neutral'
                  : invitation.deliveryState === 'sent'
                    ? 'success'
                    : invitation.deliveryState === 'failed'
                      ? 'error'
                      : 'neutral'
              }`}
            >
              {invitation.state === 'revoked'
                ? t('teamInvitationRevoked')
                : invitation.state === 'declined'
                  ? t('teamInvitationDeclined')
                  : invitation.state === 'accepted'
                    ? t('teamInvitationAccepted')
                    : invitation.state === 'expired'
                      ? t('teamInvitationExpired')
                      : invitation.deliveryState === 'sent'
                        ? t('teamInvitationSent')
                        : invitation.deliveryState === 'failed'
                          ? t('teamInvitationFailed')
                          : t('teamInvitationPending')}
            </span>
            {/* A failed delivery shows its fix on the row (024), not behind "…". */}
            {invitation.state === 'pending' &&
              invitation.deliveryState === 'failed' &&
              client.resendInvitation && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`${t('teamInvitationResend')}: ${invitation.targetEmail}`}
                  onClick={() => void resend(invitation.id)}
                >
                  {t('teamInvitationResendShort')}
                </Button>
              )}
            {invitation.state === 'pending' &&
              (client.resendInvitation || client.revokeInvitation) && (
                <MemberRowMenu
                  label={t('teamInvitationActionsFor', { email: invitation.targetEmail })}
                  items={[
                    ...(client.resendInvitation
                      ? [
                          {
                            id: 'resend',
                            label: t('teamInvitationResend'),
                            onSelect: () => void resend(invitation.id)
                          }
                        ]
                      : []),
                    ...(client.revokeInvitation
                      ? [
                          {
                            id: 'revoke',
                            label: t('teamInvitationRevoke'),
                            destructive: true,
                            onSelect: () => setConfirmingRevoke(invitation.id)
                          }
                        ]
                      : [])
                  ]}
                />
              )}
          </li>
        ))}
      </ul>
      {confirmingRevoke && (
        <Modal labelledBy={revokeTitleId} size="sm" onClose={() => setConfirmingRevoke(null)}>
          {/* Names who, then the consequence: "Revoke the invitation?" over a
              list of several left the reader to remember which row they
              pressed (024). */}
          <h3 id={revokeTitleId}>
            {t('teamInvitationRevokeConfirmTitle', {
              email:
                invitations.find(invitation => invitation.id === confirmingRevoke)?.targetEmail ??
                ''
            })}
          </h3>
          <p>{t('teamInvitationRevokeConfirmBody')}</p>
          <div className="team-dialog-actions">
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                const id = confirmingRevoke;
                setConfirmingRevoke(null);
                void revoke(id);
              }}
            >
              {t('teamInvitationRevoke')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmingRevoke(null)}>
              {t('teamCancel')}
            </Button>
          </div>
        </Modal>
      )}
    </SettingsSection>
  );
}
