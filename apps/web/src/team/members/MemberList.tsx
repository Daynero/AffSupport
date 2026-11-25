import { withReadDeadline } from '../readCoordinator';
import { useVisibleSerialRead } from '../catalog/useVisibleSerialRead';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, Users } from 'lucide-react';
import {
  Badge,
  Button,
  DropdownMenu,
  ErrorState,
  IconButton,
  LoadingState,
  Tooltip
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import type {
  TeamContextSnapshot,
  TeamMemberSummary,
  TeamPermissionOverrides
} from '../../api/team';
import {
  ROLE_PERMISSIONS,
  TEAM_PERMISSION_FLAGS,
  type TeamBaseRole
} from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { useI18n, type TranslationKey } from '../../i18n';
import { memberCountKey } from '../accounts/plural';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { MemberPermissionsDialog } from './MemberPermissionsDialog';
import { OwnershipTransferDialog } from './OwnershipTransferDialog';
import { SettingsSection } from '../workspace/SettingsSection';
import { memberAttempt } from './diagnostics';

export interface MemberManagementClient {
  listMembers: (teamId: string, options?: { signal?: AbortSignal }) => Promise<TeamMemberSummary[]>;
  updateMembership: (input: {
    teamId: string;
    userId: string;
    baseRole: TeamBaseRole;
    permissionOverrides: TeamPermissionOverrides;
  }) => Promise<TeamMemberSummary>;
  removeMember: (
    teamId: string,
    userId: string
  ) => Promise<{ ok: true; warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS' }>;
  transferOwnership: (input: {
    teamId: string;
    toUserId: string;
    demoteTo: TeamBaseRole;
  }) => Promise<TeamContextSnapshot>;
}

export interface MemberListFooterActions {
  /** Members who could become the owner. */
  candidates: readonly TeamMemberSummary[];
  /** Opens the transfer with nobody chosen yet. */
  transferOwnership: () => void;
}

const ROLE_KEY = {
  owner: 'teamRoleOwner',
  admin: 'teamRoleAdmin',
  editor: 'teamRoleEditor',
  viewer: 'teamRoleViewer'
} as const satisfies Record<TeamMemberSummary['role'], TranslationKey>;

function memberName(member: TeamMemberSummary, fallback: string) {
  return member.displayName ?? member.email ?? fallback;
}

export function MemberList({
  teamId,
  client,
  activeCount = 1,
  revision = 0,
  onChanged,
  onLoaded,
  footer
}: {
  teamId?: string;
  client?: MemberManagementClient;
  activeCount?: number;
  revision?: number;
  onChanged?: () => void;
  /** The list as read, for a neighbour whose wording depends on it. */
  onLoaded?: (members: TeamMemberSummary[]) => void;
  /**
   * The line under the list — how to leave (024, FR-049). It is handed the way to
   * start a transfer, because an owner's way out *is* a transfer: the action sits
   * where the instruction used to send them looking for it.
   */
  footer?: (actions: MemberListFooterActions) => ReactNode;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const { activeTeam, accessRevision } = useTeam();
  const auth = useOptionalAuth();
  const accessScope = JSON.stringify([
    teamId,
    auth?.user?.id,
    activeTeam?.permissions,
    accessRevision
  ]);
  const [members, setMembers] = useState<TeamMemberSummary[]>([]);
  const [editing, setEditing] = useState<TeamMemberSummary | null>(null);
  const [removing, setRemoving] = useState<TeamMemberSummary | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const removalPending = useRef(false);
  /** Whom the transfer dialog opens on: a member's id, '' for "choose", null when closed. */
  const [transferring, setTransferring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(teamId && client));
  const [retry, setRetry] = useState(0);
  const [flowId] = useState(() => crypto.randomUUID());
  const [delivered, setDelivered] = useState<ReturnType<typeof memberAttempt> | null>(null);

  useEffect(() => {
    delivered?.finish('success');
  }, [delivered]);

  useVisibleSerialRead({
    client,
    scopeKey: `${accessScope}:${retry}:${flowId}`,
    revision,
    read: async signal => {
      if (!teamId || !client) return;
      const attempt = memberAttempt('members_list', flowId);
      const cancel = () => attempt.finish('cancelled');
      signal.addEventListener('abort', cancel, { once: true });
      setLoading(true);
      setError(null);
      try {
        const value = await withReadDeadline(
          readSignal => client.listMembers(teamId, { signal: readSignal }),
          signal
        );
        if (signal.aborted) return;
        setMembers(value);
        setLoading(false);
        setError(null);
        onLoaded?.(value);
        setDelivered(attempt);
      } catch (cause) {
        if (signal.aborted) return;
        attempt.finish('failure', cause);
        setError(t('teamLoadFailed'));
        setLoading(false);
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    }
  });

  const count = client && teamId ? members.length : activeCount;
  const canManage = activeTeam?.permissions.manage_members === true;
  const isOwner = activeTeam?.role === 'owner';
  /** Who could take the space over: everyone in it but its owner. */
  const transferCandidates = members.filter(member => member.role !== 'owner');
  return (
    <SettingsSection
      icon={Users}
      titleId="team-members-list-title"
      title={t('teamMembers')}
      /* "1 of 50 members" read like paging (024). The limit is said once it is near. */
      aside={
        loading
          ? t('teamMemberLoading')
          : error
            ? null
            : t(memberCountKey(language, count), { count })
      }
      className="team-member-section"
    >
      {/* No "Role permissions" disclosure here (024): it looked like a dropdown and was read
          nowhere near the choice it explains. What a role may do is said under the role
          picker when inviting. */}
      {error && (
        <ErrorState
          title={t('teamMembers')}
          message={error}
          retryLabel={t('retry')}
          onRetry={() => setRetry(value => value + 1)}
        />
      )}
      {/* Only the first read stands in a placeholder; a re-read after a live change keeps the
          list on screen and updates it in place, instead of blanking it to rows of shimmer (058). */}
      {loading && members.length === 0 && (
        <LoadingState shape="row" count={2} label={t('teamMemberLoading')} />
      )}
      {(!loading || members.length > 0) && !error && client && teamId && (
        /* A compact list, as the space had it before 070 turned it into a table: the
           name, the address and the role on one line, the row's two actions at its end.
           Beside the invitation card there is no room for a column of dates, and a
           four-column table across the whole panel left a field of air between them. */
        <ul className="team-member-list" aria-label={t('teamMembers')}>
          {members.map(member => {
            const name = memberName(member, t('teamFormerMember'));
            const changed =
              member.role === 'owner'
                ? 0
                : TEAM_PERMISSION_FLAGS.filter(
                    flag =>
                      member.effectivePermissions[flag] !== ROLE_PERMISSIONS[member.baseRole][flag]
                  ).length;
            const self = member.userId === auth?.user?.id;
            return (
              <li key={member.membershipId} data-member-id={member.userId}>
                <div className="team-member-identity">
                  <strong className="team-member-name">
                    {name}
                    {self && <span className="team-member-self"> · {t('teamMemberYou')}</span>}
                  </strong>
                  {member.email && member.email !== name && (
                    <small className="team-member-email">{member.email}</small>
                  )}
                  <Badge
                    size="sm"
                    variant="soft"
                    color={member.role === 'owner' ? 'success' : 'neutral'}
                    className={`team-role-badge is-${member.role}`}
                  >
                    {t(ROLE_KEY[member.role])}
                  </Badge>
                  {changed > 0 && (
                    <Tooltip label={t('teamMemberCustomCount', { count: changed })}>
                      <span className="team-member-custom" tabIndex={0}>
                        {t('teamMemberCustom')}
                      </span>
                    </Tooltip>
                  )}
                </div>
                {canManage && member.role !== 'owner' && (
                  <div className="team-member-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('teamMemberEditFor', { name })}
                      onClick={() => setEditing(member)}
                    >
                      {t('teamMemberEdit')}
                    </Button>
                    {/* Rare and heavy, so behind "…" (024, FR-097): three bordered
                        buttons on every member made removing someone look as
                        ordinary as editing them. */}
                    <MemberRowMenu
                      label={t('teamMemberActionsFor', { name })}
                      items={[
                        ...(isOwner
                          ? [
                              {
                                id: 'transfer',
                                label: t('teamOwnershipTransferAction'),
                                onSelect: () => setTransferring(member.userId)
                              }
                            ]
                          : []),
                        {
                          id: 'remove',
                          label: t('teamMemberRemove'),
                          destructive: true,
                          onSelect: () => setRemoving(member)
                        }
                      ]}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {footer && !error && client && teamId && members.length > 0 && (
        <div className="team-member-footer">
          {footer({
            candidates: transferCandidates,
            transferOwnership: () => setTransferring('')
          })}
        </div>
      )}

      {editing && client && teamId && (
        <MemberPermissionsDialog
          member={editing}
          onClose={() => setEditing(null)}
          onSave={async input => {
            const attempt = memberAttempt('member_permissions_save', flowId);
            try {
              const updated = await client.updateMembership({
                teamId,
                userId: editing.userId,
                ...input
              });
              attempt.accepted();
              setMembers(current =>
                current.map(member => (member.userId === updated.userId ? updated : member))
              );
              push({
                tone: 'success',
                text: t('teamMemberSaved', { name: memberName(updated, t('teamFormerMember')) })
              });
              onChanged?.();
              setDelivered(attempt);
            } catch (cause) {
              attempt.finish('failure', cause);
              throw cause;
            }
          }}
        />
      )}

      {removing && client && teamId && (
        <Modal
          labelledBy="remove-member-title"
          onClose={removingBusy ? undefined : () => setRemoving(null)}
          closeLabel={t('teamCancel')}
          initialFocus="#confirm-remove-member"
          size="sm"
        >
          <div className="team-dialog-form">
            <h2 id="remove-member-title">{t('teamMemberRemoveTitle')}</h2>
            <p>{t('teamMemberRemoveDescription', { name: memberName(removing, '') })}</p>
            <p className="team-drive-warning">{t('teamMemberExternalDriveWarning')}</p>
            <div className="team-dialog-actions">
              <Button
                type="button"
                variant="ghost"
                disabled={removingBusy}
                onClick={() => setRemoving(null)}
              >
                {t('teamCancel')}
              </Button>
              <Button
                id="confirm-remove-member"
                type="button"
                variant="danger"
                loading={removingBusy}
                disabled={removingBusy}
                onClick={() => {
                  if (removalPending.current) return;
                  removalPending.current = true;
                  setRemovingBusy(true);
                  const attempt = memberAttempt('member_remove', flowId);
                  void client
                    .removeMember(teamId, removing.userId)
                    .then(() => {
                      attempt.accepted();
                      setMembers(current =>
                        current.filter(member => member.userId !== removing.userId)
                      );
                      setRemoving(null);
                      push({ tone: 'success', text: t('teamToastMemberRemoved') });
                      setDelivered(attempt);
                      onChanged?.();
                    })
                    // Without this the dialog simply stayed open on failure and
                    // the person was left to guess whether it had worked.
                    .catch((cause: unknown) => {
                      attempt.finish('failure', cause);
                      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
                    })
                    .finally(() => {
                      removalPending.current = false;
                      setRemovingBusy(false);
                    });
                }}
              >
                {t('teamMemberRemoveAction')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {transferring !== null && client && teamId && (
        <OwnershipTransferDialog
          members={transferCandidates}
          initialMemberId={transferring || undefined}
          onClose={() => setTransferring(null)}
          onTransfer={async (toUserId, demoteTo) => {
            await client.transferOwnership({ teamId, toUserId, demoteTo });
            onChanged?.();
          }}
        />
      )}
    </SettingsSection>
  );
}

export function MemberRowMenu({
  label,
  items
}: {
  label: string;
  items: { id: string; label: string; destructive?: boolean; onSelect: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        title=""
        ref={trigger}
        size="sm"
        variant="ghost"
        label={label}
        onClick={() => setOpen(true)}
      >
        <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        label={label}
        items={items}
      />
    </>
  );
}
