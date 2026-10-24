import { useEffect, useState } from 'react';
import { Laptop } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui/index';
import { SettingsSection } from '../workspace/SettingsSection';
import { useOptionalAgent } from '../../AgentContext';
import { useTeam } from '../TeamContext';
import { teamErrorCodeOf } from '../errors';
import {
  backgroundRecoveryStatus,
  retryBackgroundRecovery,
  enableBackgroundRecovery,
  disableBackgroundRecovery,
  type BackgroundRecoveryStatus
} from '../../api/recovery';

export function BackgroundRecoverySettings({ teamId }: { teamId: string }) {
  const agent = useOptionalAgent();
  const readable = agent?.capabilities?.includes('team-background-recovery') === true;
  const supported =
    readable && agent?.capabilities?.includes('team-background-recovery-actor-bound') === true;
  // Discard the old projection immediately when its native/team scope changes.
  // A late read or mutation completion then belongs to an unmounted panel.
  const scope = JSON.stringify([
    teamId,
    agent?.lastKnownAgent?.instanceId,
    agent?.connection,
    readable,
    supported
  ]);
  return (
    <BackgroundRecoveryPanel
      key={scope}
      teamId={teamId}
      readable={readable}
      supported={supported}
    />
  );
}

function BackgroundRecoveryPanel({
  teamId,
  readable,
  supported
}: {
  teamId: string;
  readable: boolean;
  supported: boolean;
}) {
  const { t } = useI18n();
  const { can } = useTeam();
  const [status, setStatus] = useState<BackgroundRecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<
    'tariffBackgroundFailed' | 'tariffBackgroundUpgrade' | null
  >(null);
  useEffect(() => {
    if (!readable) return;
    let live = true;
    void backgroundRecoveryStatus(teamId)
      .then(value => {
        if (live) setStatus(value);
      })
      .catch(() => {
        if (live) setFailure('tariffBackgroundFailed');
      });
    return () => {
      live = false;
    };
  }, [teamId, readable]);
  if (!can('process')) return null;
  const change = async () => {
    setBusy(true);
    setFailure(null);
    try {
      setStatus(
        await (status?.enabled
          ? disableBackgroundRecovery(teamId)
          : enableBackgroundRecovery(teamId))
      );
    } catch (error) {
      setFailure(
        teamErrorCodeOf(error) === 'AGENT_UPDATE_REQUIRED'
          ? 'tariffBackgroundUpgrade'
          : 'tariffBackgroundFailed'
      );
      setStatus(await backgroundRecoveryStatus(teamId).catch(() => null));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      titleId={`background-recovery-${teamId}`}
      icon={Laptop}
      title={t('tariffBackgroundTitle')}
    >
      <p>{t(supported ? 'tariffBackgroundDescription' : 'tariffBackgroundUpgrade')}</p>
      {status !== null && (supported || status.enabled) && (
        <Button variant="soft" loading={busy} onClick={() => void change()}>
          {t(status?.enabled ? 'tariffBackgroundDisable' : 'tariffBackgroundEnable')}
        </Button>
      )}
      {status?.state === 'blocked' && (
        <p role="status">
          {t(
            status.reason === 'retry_exhausted'
              ? 'tariffRecoveryRetry'
              : status.reason === 'needs_agent_setup'
                ? 'tariffRecoverySetup'
                : 'tariffRecoveryCheckpoint'
          )}
        </p>
      )}
      {status?.reason === 'retry_exhausted' && (
        <Button
          variant="soft"
          loading={busy}
          onClick={() => {
            setBusy(true);
            setFailure(null);
            void retryBackgroundRecovery(teamId)
              .then(setStatus)
              .catch(() => setFailure('tariffBackgroundFailed'))
              .finally(() => setBusy(false));
          }}
        >
          {t('tryAgain')}
        </Button>
      )}
      {failure && <p role="alert">{t(failure)}</p>}
    </SettingsSection>
  );
}
