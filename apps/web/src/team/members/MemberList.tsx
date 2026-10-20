import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Users } from 'lucide-react';
import {
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
import { useI18n } from '../../i18n';
import { memberCountKey } from '../accounts/plural';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { MemberPermissionsDialog } from './MemberPermissionsDialog';
import { OwnershipTransferDialog } from './OwnershipTransferDialog';
import { SettingsSection } from '../workspace/SettingsSection';
import { memberAttempt } from './diagnostics';

export interface MemberManagementClient {
  listMembers: (teamId: string) => Promise<TeamMemberSummary[]>;
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

function memberName(member: TeamMemberSummary, fallback: string) {
  return member.displayName ?? member.email ?? fallback;
}

export function MemberList({
  teamId,
  client,
  activeCount = 1,
  revision = 0,
  onChanged,
  onLoaded
}: {
  teamId?: string;
  client?: MemberManagementClient;
  activeCount?: number;
  revision?: number;
  onChanged?: () => void;
  /** The list as read, for a neighbour whose wording depends on it. */
  onLoaded?: (members: TeamMemberSummary[]) => void;
}) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const { activeTeam } = useTeam();
  const [members, setMembers] = useState<TeamMemberSummary[]>([]);
  const [editing, setEditing] = useState<TeamMemberSummary | null>(null);
  const [removing, setRemoving] = useState<TeamMemberSummary | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const removalPending = useRef(false);
  const [transferring, setTransferring] = useState<TeamMemberSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(teamId && client));
  const [retry, setRetry] = useState(0);
  const [flowId] = useState(() => crypto.randomUUID());
  const [delivered, setDelivered] = useState<ReturnType<typeof memberAttempt> | null>(null);

  useEffect(() => {
    delivered?.finish('success');
  }, [delivered]);

  useEffect(() => {
    if (!teamId || !client) return;
    let active = true;
    const attempt = memberAttempt('members_list', flowId);
    setLoading(true);
    setError(null);
    void client
      .listMembers(teamId)
      .then(value => {
        if (active) {
          setMembers(value);
          setLoading(false);
          setError(null);
          onLoaded?.(value);
          setDelivered(attempt);
        }
      })
      .catch((cause: unknown) => {
        attempt.finish('failure', cause);
        if (active) {
          setError(t('teamLoadFailed'));
          setLoading(false);
        }
      });
    return () => {
      active = false;
      attempt.finish('cancelled');
    };
    // `onLoaded` is left out on purpose: a caller's inline callback would re-read
    // the list on every render.
  }, [client, revision, retry, t, teamId, flowId]);

  const count = client && teamId ? members.length : activeCount;
  const canManage = activeTeam?.permissions.manage_members === true;
  const isOwner = activeTeam?.role === 'owner';
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
            : count >= 40
              ? t('teamMembersLimit', { count })
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
      {loading && <LoadingState shape="row" count={2} label={t('teamMemberLoading')} />}
      {!loading && !error && client && teamId && (
        <ul className="team-member-list">
          {members.map(member => {
            const name = memberName(member, t('teamFormerMember'));
            const custom =
              member.role !== 'owner' &&
              TEAM_PERMISSION_FLAGS.some(
                flag =>
                  member.effectivePermissions[flag] !== ROLE_PERMISSIONS[member.baseRole][flag]
              );
            return (
              <li key={member.membershipId}>
                <div>
                  <strong>{name}</strong>
                  {member.email && member.email !== name && <small>{member.email}</small>}
                  <span className={`team-role-badge is-${member.role}`}>
                    {t(
                      member.role === 'owner'
                        ? 'teamRoleOwner'
                        : member.role === 'admin'
                          ? 'teamRoleAdmin'
                          : member.role === 'editor'
                            ? 'teamRoleEditor'
                            : 'teamRoleViewer'
                    )}
                  </span>
                  {custom && (
                    <Tooltip
                      label={t('teamMemberCustomCount', {
                        count: TEAM_PERMISSION_FLAGS.filter(
                          flag =>
                            member.effectivePermissions[flag] !==
                            ROLE_PERMISSIONS[member.baseRole][flag]
                        ).length
                      })}
                    >
                      <span className="team-member-custom" tabIndex={0}>
                        {t('teamMemberCustom')}
                      </span>
                    </Tooltip>
                  )}
                </div>
                {canManage && member.role !== 'owner' && (
                  <div className="team-inline-actions">
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
                                onSelect: () => setTransferring(member)
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

      {transferring && client && teamId && (
        <OwnershipTransferDialog
          member={transferring}
          onClose={() => setTransferring(null)}
          onTransfer={async demoteTo => {
            await client.transferOwnership({
              teamId,
              toUserId: transferring.userId,
              demoteTo
            });
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
