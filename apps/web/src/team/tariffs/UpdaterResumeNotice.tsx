import { useState } from 'react';
import { spaceTariffApi } from '../../api/team';
import { RefreshCw } from 'lucide-react';
import type { RecoveryReason } from '@video-compressor/shared';
import { Alert, Button } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { useTeam } from '../TeamContext';
import { buildTeamRoute } from '../routes';
import { useOptionalSpaceAccess } from './useSpaceAccess';

const REASON_TEXT: Record<RecoveryReason, TranslationKey> = {
  waiting_agent: 'tariffRecoveryAgent',
  waiting_drive: 'tariffRecoveryDrive',
  needs_agent_setup: 'tariffRecoverySetup',
  permission_revoked: 'tariffRecoveryPermissions',
  manually_disabled: 'tariffRecoveryManual',
  user_cancelled: 'tariffRecoveryCancelled',
  source_changed: 'tariffRecoverySource',
  source_missing: 'tariffRecoverySource',
  checkpoint_unavailable: 'tariffRecoveryCheckpoint',
  queue_registration_failed: 'tariffRecoveryQueue',
  retry_exhausted: 'tariffRecoveryRetry',
  superseded: 'tariffRecoverySuperseded',
  unknown: 'tariffRecoveryUnknown'
};

/** Server recovery projection; queued work never produces a completed toast. */
export function UpdaterResumeNotice({
  teamId,
  compact = false
}: {
  teamId: string;
  /** Compatibility props retained for older callers; normal recovery is server-owned. */
  onResumed?: () => void;
  resume?: (teamId: string) => Promise<boolean>;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const { can } = useTeam();
  const access = useOptionalSpaceAccess();
  const tariff = access?.access?.teams.find(team => team.teamId === teamId)?.tariff;
  const recovery = tariff?.recovery;
  if (
    !can('process') ||
    (!recovery && !tariff?.updaterPausedByTariff) ||
    recovery?.state === 'superseded'
  )
    return null;
  const title = !recovery
    ? 'tariffRecoveryUnknown'
    : recovery.state === 'completed'
      ? recovery.counts.skipped > 0
        ? 'tariffRecoverySettled'
        : 'tariffRecoveryComplete'
      : recovery.state === 'partial' || recovery.state === 'waiting_dependency'
        ? 'tariffRecoveryPartial'
        : 'tariffRecoveryRunning';
  const manageable =
    recovery?.canManageRecovery &&
    recovery.reasons.some(reason => reason.action === 'agent' || reason.action === 'drive');
  const retryable =
    recovery?.canManageRecovery && recovery.reasons.some(reason => reason.action === 'retry');
  const retry = async () => {
    if (!recovery || retrying) return;
    setRetrying(true);
    setRetryFailed(false);
    try {
      if (!(await spaceTariffApi.retryRecovery(recovery.id))) throw new Error('INVALID_RESPONSE');
      access?.recheck();
    } catch {
      setRetryFailed(true);
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Alert
      className={compact ? 'tariff-updater-notice is-compact' : 'tariff-updater-notice'}
      color="info"
      variant={compact ? 'subtle' : 'soft'}
      icon={<RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
      action={
        manageable ? (
          <Button
            size="sm"
            variant="soft"
            onClick={() =>
              navigateTo(
                buildTeamRoute({ spaceId: teamId, section: 'explorer', query: { settings: true } })
              )
            }
          >
            {t('tariffRecoverySettings')}
          </Button>
        ) : retryable ? (
          <Button size="sm" variant="soft" loading={retrying} onClick={() => void retry()}>
            {t('tryAgain')}
          </Button>
        ) : undefined
      }
    >
      <span>{t(title)}</span>
      {retryFailed && (
        <span role="alert">
          <br />
          {t('tariffRecoveryQueue')}
        </span>
      )}
      {recovery?.reasons.map(reason => (
        <span key={reason.code}>
          <br />
          {t(REASON_TEXT[reason.code])}
        </span>
      ))}
    </Alert>
  );
}
