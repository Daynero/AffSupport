import { useEffect, useState } from 'react';
import type {
  TeamContextSnapshot,
  TeamMemberSummary,
  TeamPermissionOverrides
} from '../../api/team';
import type { TeamBaseRole } from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { MemberPermissionsDialog } from './MemberPermissionsDialog';
import { OwnershipTransferDialog } from './OwnershipTransferDialog';

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
  onChanged
}: {
  teamId?: string;
  client?: MemberManagementClient;
  activeCount?: number;
  revision?: number;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { activeTeam } = useTeam();
  const [members, setMembers] = useState<TeamMemberSummary[]>([]);
  const [editing, setEditing] = useState<TeamMemberSummary | null>(null);
  const [removing, setRemoving] = useState<TeamMemberSummary | null>(null);
  const [transferring, setTransferring] = useState<TeamMemberSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId || !client) return;
    let active = true;
    void client
      .listMembers(teamId)
      .then(value => {
        if (active) {
          setMembers(value);
          setError(null);
        }
      })
      .catch(() => {
        if (active) setError(t('teamLoadFailed'));
      });
    return () => {
      active = false;
    };
  }, [client, revision, t, teamId]);

  const count = client && teamId ? members.length : activeCount;
  const canManage = activeTeam?.permissions.manage_members === true;
  const isOwner = activeTeam?.role === 'owner';
  return (
    <section className="team-member-section" aria-labelledby="team-members-list-title">
      <div className="team-member-limit">
        <strong id="team-members-list-title">{t('teamMembers')}</strong>
        <span>{t('teamMembersLimit', { count })}</span>
      </div>
      {client && teamId && (
        <details className="team-role-guide">
          <summary>{t('teamRolesGuide')}</summary>
          <dl>
            <div>
              <dt>{t('teamRoleOwner')}</dt>
              <dd>{t('teamRoleOwnerDescription')}</dd>
            </div>
            <div>
              <dt>{t('teamRoleAdmin')}</dt>
              <dd>{t('teamRoleAdminDescription')}</dd>
            </div>
            <div>
              <dt>{t('teamRoleEditor')}</dt>
              <dd>{t('teamRoleEditorDescription')}</dd>
            </div>
            <div>
              <dt>{t('teamRoleViewer')}</dt>
              <dd>{t('teamRoleViewerDescription')}</dd>
            </div>
          </dl>
        </details>
      )}
      {error && <p className="team-inline-error">{error}</p>}
      {client && teamId && (
        <ul className="team-member-list">
          {members.map(member => {
            const name = memberName(member, t('teamFormerMember'));
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
                </div>
                {canManage && member.role !== 'owner' && (
                  <div className="team-inline-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={t('teamMemberEditFor', { name })}
                      onClick={() => setEditing(member)}
                    >
                      {t('teamMemberEdit')}
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      aria-label={t('teamMemberRemoveFor', { name })}
                      onClick={() => setRemoving(member)}
                    >
                      {t('teamMemberRemove')}
                    </Button>
                    {isOwner && (
                      <Button
                        type="button"
                        variant="secondary"
                        aria-label={t('teamOwnershipTransferFor', { name })}
                        onClick={() => setTransferring(member)}
                      >
                        {t('teamOwnershipTransferAction')}
                      </Button>
                    )}
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
            const updated = await client.updateMembership({
              teamId,
              userId: editing.userId,
              ...input
            });
            setMembers(current =>
              current.map(member => (member.userId === updated.userId ? updated : member))
            );
            onChanged?.();
          }}
        />
      )}

      {removing && client && teamId && (
        <Modal
          labelledBy="remove-member-title"
          onClose={() => setRemoving(null)}
          closeLabel={t('teamCancel')}
          initialFocus="#confirm-remove-member"
          size="sm"
        >
          <div className="team-dialog-form">
            <h2 id="remove-member-title">{t('teamMemberRemoveTitle')}</h2>
            <p>{t('teamMemberRemoveDescription', { name: memberName(removing, '') })}</p>
            <p className="team-drive-warning">{t('teamMemberExternalDriveWarning')}</p>
            <div className="team-dialog-actions">
              <Button type="button" variant="ghost" onClick={() => setRemoving(null)}>
                {t('teamCancel')}
              </Button>
              <Button
                id="confirm-remove-member"
                type="button"
                variant="danger"
                onClick={() =>
                  void client
                    .removeMember(teamId, removing.userId)
                    .then(() => {
                      setMembers(current =>
                        current.filter(member => member.userId !== removing.userId)
                      );
                      setRemoving(null);
                      push({ tone: 'success', text: t('teamToastMemberRemoved') });
                      onChanged?.();
                    })
                    // Without this the dialog simply stayed open on failure and
                    // the person was left to guess whether it had worked.
                    .catch((cause: unknown) => {
                      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
                    })
                }
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
    </section>
  );
}
