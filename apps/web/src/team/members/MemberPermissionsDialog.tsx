import { useRef, useState, type FormEvent } from 'react';
import { Info, LockKeyhole } from 'lucide-react';
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
import {
  Button,
  Checkbox,
  ConfirmDialog,
  FormField,
  IconButton,
  Select,
  Popover
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';

export const PERMISSION_COPY: Record<TeamPermissionFlag, TranslationKey> = {
  view: 'teamPermissionView',
  download: 'teamPermissionDownload',
  upload: 'teamPermissionUpload',
  edit: 'teamPermissionEdit',
  delete: 'teamPermissionDelete',
  process: 'teamPermissionProcess',
  manage_members: 'teamPermissionManageMembers',
  manage_metadata: 'teamPermissionManageMetadata'
};

const PERMISSION_HINT: Record<TeamPermissionFlag, TranslationKey> = {
  view: 'teamMemberViewHint',
  download: 'teamMemberDownloadHint',
  upload: 'teamMemberUploadHint',
  edit: 'teamMemberEditHint',
  delete: 'teamMemberDeleteHint',
  process: 'teamMemberProcessHint',
  manage_members: 'teamMemberManageHint',
  manage_metadata: 'teamMemberMetadataHint'
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
  const [overrides, setOverrides] = useState<TeamPermissionOverrides>(member.permissionOverrides);
  const permissions = { ...ROLE_PERMISSIONS[baseRole], ...overrides };
  const customCount = TEAM_PERMISSION_FLAGS.filter(
    flag => permissions[flag] !== ROLE_PERMISSIONS[baseRole][flag]
  ).length;
  const dirty =
    baseRole !== member.baseRole ||
    TEAM_PERMISSION_FLAGS.some(flag => permissions[flag] !== member.effectivePermissions[flag]);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (saving.current) return;
    if (dirty) setDiscarding(true);
    else onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave({ baseRole, permissionOverrides: sparseOverrides(baseRole, permissions) });
      onClose();
    } catch (cause) {
      setError(teamErrorMessageFor(cause, t));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        labelledBy="member-permissions-title"
        onClose={busy ? undefined : close}
        closeLabel={t('teamMemberClose')}
        initialFocus=".ui-select-trigger"
        size="md"
        className="team-member-permissions-dialog"
      >
        <form className="team-dialog-form" aria-busy={busy} onSubmit={event => void submit(event)}>
          <h2 id="member-permissions-title">{t('teamMemberPermissionsTitle')}</h2>
          <p>{member.displayName ?? member.email ?? t('teamFormerMember')}</p>
          <div className="team-member-permission-body">
            <FormField
              label={<span id="member-role-label">{t('teamMemberBaseRole')}</span>}
              help={t('teamMemberRoleHint')}
            >
              <Select
                aria-labelledby="member-role-label"
                disabled={busy}
                value={baseRole}
                onChange={role => setBaseRole(role as TeamBaseRole)}
                options={TEAM_BASE_ROLES.map(role => ({
                  value: role,
                  label: t(
                    role === 'admin'
                      ? 'teamRoleAdmin'
                      : role === 'editor'
                        ? 'teamRoleEditor'
                        : 'teamRoleViewer'
                  )
                }))}
              />
            </FormField>
            <div className="team-member-permissions-summary">
              <span role="status">
                {customCount
                  ? t('teamMemberCustomCount', { count: customCount })
                  : t('teamMemberRoleDefaults')}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || customCount === 0}
                onClick={() => setOverrides({})}
              >
                {t('teamMemberReset')}
              </Button>
            </div>
            <fieldset className="team-member-permission-groups" disabled={busy}>
              <legend>{t('teamMemberOverrides')}</legend>
              {(
                [
                  ['teamMemberFiles', ['view', 'download', 'upload', 'edit', 'delete', 'process']],
                  ['teamMemberWorkspace', ['manage_metadata', 'manage_members']]
                ] as const
              ).map(([title, flags]) => (
                <div className="team-member-permission-group" key={title}>
                  <h3>{t(title)}</h3>
                  {flags.map(flag => (
                    <div className="team-member-permission-row" key={flag}>
                      <Checkbox
                        disabled={busy}
                        label={t(PERMISSION_COPY[flag])}
                        checked={permissions[flag]}
                        onChange={checked =>
                          setOverrides(current => {
                            const next = { ...current };
                            if (checked === ROLE_PERMISSIONS[baseRole][flag]) delete next[flag];
                            else next[flag] = checked;
                            return next;
                          })
                        }
                      />
                      <PermissionHelp
                        label={t('teamMemberDetails', { permission: t(PERMISSION_COPY[flag]) })}
                        text={t(PERMISSION_HINT[flag])}
                        disabled={busy}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </fieldset>
            <p className="team-member-owner-note">
              <LockKeyhole size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('teamTagOwnerOnly')}
            </p>
            <p className="team-member-scope">
              {t('teamMemberScope')} {t('teamMemberDependencies')}
            </p>
            {error && (
              <p className="team-inline-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="team-dialog-actions team-member-permission-footer">
            <span className="team-member-draft-status" role="status">
              {busy ? t('teamMemberSaving') : dirty ? t('teamMemberUnsaved') : ''}
            </span>
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>
              {t('teamCancel')}
            </Button>
            <Button
              type="submit"
              color="success"
              variant="solid"
              loading={busy}
              disabled={!dirty || busy}
            >
              {busy ? t('teamMemberSaving') : t('teamMemberSavePermissions')}
            </Button>
          </div>
        </form>
      </Modal>
      <ConfirmDialog
        open={discarding}
        initialFocus="cancel"
        nested
        onCancel={() => setDiscarding(false)}
        onConfirm={onClose}
        title={t('teamMemberDiscardTitle')}
        body={t('teamMemberDiscardBody')}
        confirmLabel={t('teamMemberDiscard')}
        cancelLabel={t('teamMemberKeepEditing')}
      />
    </>
  );
}

function PermissionHelp({
  label,
  text,
  disabled
}: {
  label: string;
  text: string;
  disabled: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        ref={anchor}
        type="button"
        size="sm"
        variant="ghost"
        title=""
        label={label}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(current => !current)}
      >
        <Info size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      <Popover
        open={open && !disabled}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={label}
        placement="bottom-end"
        className="team-member-permission-help"
      >
        <p>{text}</p>
      </Popover>
    </>
  );
}
