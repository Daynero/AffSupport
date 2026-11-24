import { useId, useState } from 'react';
import { ArrowRightLeft, LogOut } from 'lucide-react';
import { Button } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { teamResolverRoute } from '../routes';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';

export interface LeaveSpaceClient {
  leaveTeam: (teamId: string) => Promise<{ ok: true; warningCode: string }>;
}

/**
 * Leaving a space, which until now had no way out at all short of asking an
 * admin to remove you (finding I2).
 *
 * The owner sees the reason rather than a disabled button: a space cannot be
 * left without an owner, and the way out is to transfer ownership first — which
 * is a thing they can actually do, in the list above.
 *
 * It lives under Members, not in the settings (024, FR-049). Leaving was in
 * the settings' General tab and transferring ownership was on a member's row,
 * so an owner told "transfer first" was sent to a different screen to find out
 * how.
 *
 * It is one line now, not a card (070, T051): what leaving costs, in a caption,
 * and the press that does it. An owner's press is the transfer itself — the
 * instruction "… beside a member → Transfer ownership" was a route through the
 * page written out as prose, and the action it described can simply be here.
 */
export function LeaveSpacePanel({
  teamId,
  client,
  isOwner,
  alone = false,
  onTransferOwnership
}: {
  teamId: string;
  client: LeaveSpaceClient;
  isOwner: boolean;
  /** Nobody else is in the space: an owner then has no way out to show. */
  alone?: boolean;
  /** Opens the ownership transfer — an owner's only way out. */
  onTransferOwnership?: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { setActiveTeamId, refreshTeams, replaceTeams, teams } = useTeam();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const labelId = useId();

  const leave = async () => {
    setBusy(true);
    try {
      await client.leaveTeam(teamId);
      setConfirming(false);
      setActiveTeamId(null);
      // The space has to leave the list too, or the entry resolver would send
      // this person straight back into the space they just left. Dropped
      // locally first — the server has already told us the membership ended, so
      // waiting for a refetch would leave a window where the redirect wins.
      replaceTeams(teams.filter(team => team.id !== teamId));
      await refreshTeams();
      // The standing warning, said at the moment it becomes true: Google Drive
      // keeps its own sharing ACL, which leaving does not touch.
      push({ tone: 'info', text: t('teamLeaveDone'), sticky: true });
      navigateTo(teamResolverRoute(), true);
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  // An owner alone in the space has nothing to do here: no one to hand it to and nothing to press.
  // The card said so at full width under the members, and read as a problem to solve (024).
  if (isOwner && alone) return null;

  return (
    <div className="team-leave-row" role="group" aria-labelledby={labelId}>
      <LogOut
        className="team-leave-icon"
        size={ICON_SIZE}
        strokeWidth={ICON_STROKE}
        aria-hidden="true"
      />
      <p className="team-leave-copy">
        <span id={labelId} className="team-leave-title">
          {t('teamLeaveTitle')}
        </span>
        <span className="team-leave-note">
          {isOwner ? t('teamLeaveOwnerExplanation') : t('teamLeaveDescription')}
        </span>
      </p>
      {isOwner ? (
        onTransferOwnership && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            leading={<ArrowRightLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
            onClick={onTransferOwnership}
          >
            {t('teamOwnershipTransferStart')}
          </Button>
        )
      ) : (
        <Button
          type="button"
          color="error"
          variant="ghost"
          size="sm"
          onClick={() => setConfirming(true)}
        >
          {t('teamLeaveAction')}
        </Button>
      )}
      {confirming && (
        <Modal labelledBy={titleId} size="sm" onClose={() => setConfirming(false)}>
          <h3 id={titleId}>{t('teamLeaveConfirmTitle')}</h3>
          {/* Names the consequence rather than asking "are you sure?" */}
          <p>{t('teamLeaveConfirmBody')}</p>
          <div className="team-dialog-actions">
            <Button type="button" variant="danger" loading={busy} onClick={() => void leave()}>
              {t('teamLeaveAction')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              {t('teamCancel')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
