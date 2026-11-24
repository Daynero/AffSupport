import { useState, type FormEvent } from 'react';
import { TEAM_BASE_ROLES, type TeamBaseRole } from '@video-compressor/shared';
import type { TeamMemberSummary } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button, Checkbox, FormField, Select, SelectMenu } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorCodeOf } from '../errors';
import { useOptionalTeam } from '../TeamContext';
import { useOptionalSpaceAccess } from '../tariffs/useSpaceAccess';

const ROLE_KEY = {
  admin: 'teamRoleAdmin',
  editor: 'teamRoleEditor',
  viewer: 'teamRoleViewer'
} as const;

/**
 * Handing the space to someone else (024, FR-049; 070, T051).
 *
 * The new owner is chosen here, from a list that can be searched — opened from a
 * member's "…" it starts on that member, opened from "Leaving this space" it starts
 * empty. Before this the dialog could only be reached from a member's row, and an
 * owner who wanted to leave was given a sentence telling them to go and find it.
 */
export function OwnershipTransferDialog({
  members,
  initialMemberId,
  onClose,
  onTransfer
}: {
  /** Who could become the owner: everyone in the space but its owner. */
  members: readonly TeamMemberSummary[];
  /** The member the dialog opens on; absent when the owner is still to choose. */
  initialMemberId?: string;
  onClose: () => void;
  onTransfer: (toUserId: string, demoteTo: TeamBaseRole) => Promise<void>;
}) {
  const { t } = useI18n();
  const [toUserId, setToUserId] = useState(initialMemberId ?? '');
  const [demoteTo, setDemoteTo] = useState<TeamBaseRole>('admin');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teamId = useOptionalTeam()?.activeTeamId ?? null;
  const tariffState =
    useOptionalSpaceAccess()?.access?.teams.find(team => team.teamId === teamId)?.tariff ?? null;
  const chosen = members.find(member => member.userId === toUserId) ?? null;
  const memberName = chosen ? (chosen.displayName ?? chosen.email ?? t('teamFormerMember')) : '';
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
    if (!confirmed || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      await onTransfer(chosen.userId, demoteTo);
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
      initialFocus={chosen ? '.team-ownership-role .ui-select-trigger' : '#ownership-new-owner'}
      size="sm"
    >
      <form className="team-dialog-form" onSubmit={event => void submit(event)}>
        <h2 id="ownership-transfer-title">{t('teamOwnershipTransferTitle')}</h2>
        <p>
          {chosen
            ? t('teamOwnershipTransferDescription', { name: memberName })
            : t('teamOwnershipTransferPick')}
        </p>
        <FormField label={t('teamOwnershipNewOwner')} htmlFor="ownership-new-owner">
          <SelectMenu
            id="ownership-new-owner"
            label={t('teamOwnershipNewOwner')}
            value={toUserId}
            showSearchIcon
            options={members.map(member => ({
              value: member.userId,
              label: member.displayName ?? member.email ?? t('teamFormerMember'),
              description: member.displayName && member.email ? member.email : undefined,
              searchText: member.email ?? undefined
            }))}
            placeholder={t('teamOwnershipNewOwnerPlaceholder')}
            noResultsLabel={t('teamOwnershipNobodyFound')}
            errorLabel={t('teamOwnershipTransferFailed')}
            onChange={value => {
              setToUserId(value);
              // Agreeing to hand the space to one person is not agreeing for another.
              setConfirmed(false);
            }}
          />
        </FormField>
        <FormField
          className="team-ownership-role"
          label={<span id="former-owner-role-label">{t('teamOwnershipFormerRole')}</span>}
        >
          <Select
            aria-labelledby="former-owner-role-label"
            value={demoteTo}
            options={TEAM_BASE_ROLES.map(role => ({ value: role, label: t(ROLE_KEY[role]) }))}
            onChange={value => setDemoteTo(value as TeamBaseRole)}
          />
        </FormField>
        <Checkbox
          checked={confirmed}
          disabled={!chosen}
          onChange={value => setConfirmed(value)}
          label={
            chosen
              ? t('teamOwnershipConfirm', { name: memberName })
              : t('teamOwnershipConfirmChooseFirst')
          }
        />
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
          <Button type="submit" variant="danger" loading={busy} disabled={!confirmed || !chosen}>
            {t('teamOwnershipTransferAction')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
