import { useState } from 'react';
import { disableBackgroundRecovery, type BackgroundRecoveryStatus } from '../../api/recovery.js';
import { Alert, Button } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';
import { teamErrorMessageFor } from '../errors.js';

/**
 * Normal automatic setup is quiet; an authority/update problem must remain visible.
 *
 * A computer whose own credential the server refused is not «no permission»: the person has it,
 * Soty lost it (incident 2026-11-22 — a lost rotation reply parked two spaces' background work
 * for two days, and «Готуємо відео…» never moved). That case says so and offers to set it up
 * again here: the old credential is withdrawn and the page sets up a new one by itself.
 */
export function BackgroundRecoveryNotice({
  teamId,
  status,
  errorCode
}: {
  teamId: string;
  status: BackgroundRecoveryStatus | null;
  errorCode: string | null;
}) {
  const { t } = useI18n();
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const lost =
    !errorCode && status?.automaticSetup === 'blocked' && status.reason === 'needs_agent_setup';
  const code = errorCode ?? (status?.automaticSetup === 'blocked' ? 'PERMISSION_DENIED' : null);
  if (!code) return null;
  if (lost) {
    const repair = async () => {
      setRepairing(true);
      setRepairError(null);
      try {
        // Withdraws the refused credential on both sides; the page's own setup loop hears the
        // change and sets up a new one.
        await disableBackgroundRecovery(teamId);
      } catch (error) {
        setRepairError(
          error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.message)
            ? error.message
            : 'NETWORK'
        );
      } finally {
        setRepairing(false);
      }
    };
    return (
      <Alert
        color="warning"
        variant="subtle"
        action={
          <Button variant="outline" size="sm" disabled={repairing} onClick={() => void repair()}>
            {t(repairing ? 'backgroundRecoveryRepairing' : 'backgroundRecoveryRepair')}
          </Button>
        }
      >
        <span>
          {t('backgroundRecoveryLost')}
          {repairError ? ` ${teamErrorMessageFor({ code: repairError }, t)}` : ''}
        </span>
      </Alert>
    );
  }
  return (
    <Alert color="warning" variant="subtle">
      <span>
        {t('backgroundRecoveryAttention')} {teamErrorMessageFor({ code }, t)}
      </span>
    </Alert>
  );
}
