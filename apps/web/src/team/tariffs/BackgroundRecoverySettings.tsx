import { useEffect, useState } from 'react';
import { Laptop } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui/index';
import { SettingsSection } from '../workspace/SettingsSection';
import { useOptionalAgent } from '../../AgentContext';
import { useTeam } from '../TeamContext';
import {
  backgroundRecoveryStatus,
  retryBackgroundRecovery,
  enableBackgroundRecovery,
  disableBackgroundRecovery,
  type BackgroundRecoveryStatus
} from '../../api/recovery';

export function BackgroundRecoverySettings({ teamId }: { teamId: string }) {
  const { t } = useI18n();
  const { can } = useTeam();
  const agent = useOptionalAgent();
  const supported = agent?.capabilities?.includes('team-background-recovery') === true;
  const [status, setStatus] = useState<BackgroundRecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    void backgroundRecoveryStatus(teamId)
      .then(value => {
        if (live) setStatus(value);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [teamId, supported]);
  if (!can('process')) return null;
  const change = async () => {
    setBusy(true);
    setFailed(false);
    try {
      setStatus(
        await (status?.enabled
          ? disableBackgroundRecovery(teamId)
          : enableBackgroundRecovery(teamId))
      );
    } catch {
      setFailed(true);
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
      {supported && (
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
            setFailed(false);
            void retryBackgroundRecovery(teamId)
              .then(setStatus)
              .catch(() => setFailed(true))
              .finally(() => setBusy(false));
          }}
        >
          {t('tryAgain')}
        </Button>
      )}
      {failed && <p role="alert">{t('tariffBackgroundFailed')}</p>}
    </SettingsSection>
  );
}
