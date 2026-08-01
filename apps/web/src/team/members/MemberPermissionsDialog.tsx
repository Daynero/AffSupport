import { useState, type FormEvent } from 'react';
import {
  ROLE_PERMISSIONS,
  TEAM_BASE_ROLES,
  TEAM_PERMISSION_FLAGS,
  type TeamBaseRole,
  type TeamPermissionFlag,
  type TeamPermissions
} from '@video-compressor/shared';
import type { TeamMemberSummary, TeamPermissionOverrides } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n, type TranslationKey } from '../../i18n';

const PERMISSION_COPY: Record<TeamPermissionFlag, TranslationKey> = {
  view: 'teamPermissionView',
  download: 'teamPermissionDownload',
  upload: 'teamPermissionUpload',
  edit: 'teamPermissionEdit',
  delete: 'teamPermissionDelete',
  process: 'teamPermissionProcess',
  manage_members: 'teamPermissionManageMembers',
  manage_metadata: 'teamPermissionManageMetadata'
};

function sparseOverrides(
  baseRole: TeamBaseRole,
  permissions: TeamPermissions
): TeamPermissionOverrides {
  return Object.fromEntries(
    TEAM_PERMISSION_FLAGS.flatMap(flag =>
      permissions[flag] === ROLE_PERMISSIONS[baseRole][flag]
        ? []
        : ([[flag, permissions[flag]]] as const)
    )
  );
}

export function MemberPermissionsDialog({
  member,
  onClose,
  onSave
}: {
  member: TeamMemberSummary;
  onClose: () => void;
  onSave: (input: {
    baseRole: TeamBaseRole;
    permissionOverrides: TeamPermissionOverrides;
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [baseRole, setBaseRole] = useState(member.baseRole);
  const [permissions, setPermissions] = useState<TeamPermissions>(member.effectivePermissions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({ baseRole, permissionOverrides: sparseOverrides(baseRole, permissions) });
      onClose();
    } catch {
      setError(t('teamMemberUpdateFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      labelledBy="member-permissions-title"
      onClose={onClose}
      closeLabel={t('teamCancel')}
      initialFocus="#member-base-role"
      size="md"
    >
      <form className="team-dialog-form" onSubmit={event => void submit(event)}>
        <h2 id="member-permissions-title">{t('teamMemberPermissionsTitle')}</h2>
        <p>{member.displayName ?? member.email ?? t('teamFormerMember')}</p>
        <label>
          <span>{t('teamMemberBaseRole')}</span>
          <select
            id="member-base-role"
            value={baseRole}
            onChange={event => {
              const nextRole = event.target.value as TeamBaseRole;
              setBaseRole(nextRole);
              setPermissions({
                ...ROLE_PERMISSIONS[nextRole],
                ...member.permissionOverrides
              });
            }}
          >
            {TEAM_BASE_ROLES.map(role => (
              <option key={role} value={role}>
                {t(
                  role === 'admin'
                    ? 'teamRoleAdmin'
                    : role === 'editor'
                      ? 'teamRoleEditor'
                      : 'teamRoleViewer'
                )}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="team-permission-grid">
          <legend>{t('teamMemberOverrides')}</legend>
          {TEAM_PERMISSION_FLAGS.map(flag => (
            <label key={flag}>
              <input
                type="checkbox"
                checked={permissions[flag]}
                onChange={event =>
                  setPermissions(current => ({ ...current, [flag]: event.target.checked }))
                }
              />
              <span>{t(PERMISSION_COPY[flag])}</span>
            </label>
          ))}
        </fieldset>
        <p className="team-drive-warning">{t('teamDriveIndependentAcl')}</p>
        {error && <p className="team-inline-error">{error}</p>}
        <div className="team-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('teamCancel')}
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {t('teamMemberSavePermissions')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
