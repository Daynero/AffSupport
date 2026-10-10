import { useState, type FormEvent } from 'react';
import { TEAM_BASE_ROLES, type TeamBaseRole } from '@video-compressor/shared';
import type { TeamMemberSummary } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { teamErrorCodeOf } from '../errors';
import { useOptionalTeam } from '../TeamContext';
import { useOptionalSpaceAccess } from '../tariffs/useSpaceAccess';

export function OwnershipTransferDialog({
  member,
  onClose,
  onTransfer
}: {
  member: TeamMemberSummary;
  onClose: () => void;
  onTransfer: (demoteTo: TeamBaseRole) => Promise<void>;
}) {
  const { t } = useI18n();
  const memberName = member.displayName ?? member.email ?? t('teamFormerMember');
  const [demoteTo, setDemoteTo] = useState<TeamBaseRole>('admin');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teamId = useOptionalTeam()?.activeTeamId ?? null;
  const tariffState =
    useOptionalSpaceAccess()?.access?.teams.find(team => team.teamId === teamId)?.tariff ?? null;
  // Said before the press, not only after it: the server refuses a space bound
  // to a plan that is still running, and the reader should know why up front.
  const bound =
    tariffState !== null &&
    tariffState.planCode !== null &&
    (tariffState.state === 'active' ||
      tariffState.state === 'expiring' ||
      tariffState.state === 'grace');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await onTransfer(demoteTo);
      onClose();
    } catch (cause) {
      // 034, US4.4 — a space on a tariff is not handed over from here.
      setError(
        teamErrorCodeOf(cause) === 'TARIFF_BOUND'
          ? t('tariffErrorBound')
          : t('teamOwnershipTransferFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      labelledBy="ownership-transfer-title"
      onClose={onClose}
      closeLabel={t('teamCancel')}
      initialFocus="#former-owner-role"
      size="sm"
    >
      <form className="team-dialog-form" onSubmit={event => void submit(event)}>
        <h2 id="ownership-transfer-title">{t('teamOwnershipTransferTitle')}</h2>
        <p>{t('teamOwnershipTransferDescription', { name: memberName })}</p>
        <label>
          <span>{t('teamOwnershipFormerRole')}</span>
          <select
            id="former-owner-role"
            value={demoteTo}
            onChange={event => setDemoteTo(event.target.value as TeamBaseRole)}
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
        <label className="team-confirm-check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={event => setConfirmed(event.target.checked)}
          />
          <span>{t('teamOwnershipConfirm', { name: memberName })}</span>
        </label>
        {/* Transferring is most often the step before leaving, so the dialog
            says where leaving is (024, FR-049). */}
        <p>{t('teamOwnershipThenLeave')}</p>
        {bound && (
          <p className="team-inline-error" role="status">
            {t('tariffErrorBound')}
          </p>
        )}
        <p className="team-drive-warning">{t('teamDriveIndependentAcl')}</p>
        {error && (
          <p className="team-inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="team-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('teamCancel')}
          </Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!confirmed}>
            {t('teamOwnershipTransferAction')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
