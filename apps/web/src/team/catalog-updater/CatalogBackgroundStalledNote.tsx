import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useOptionalAgent } from '../../AgentContext';
import { disableBackgroundRecovery } from '../../api/recovery.js';
import { Button } from '../../components/ui/index.js';
import { teamErrorMessageFor } from '../errors.js';

/**
 * A round the server handed to this computer's background work, which never took it.
 *
 * Production 2026-11-24 (Windows): the note said «Перезапустіть Soty», and restarting did not
 * help — the stored handle no longer read back, and nothing on the page could set the space up
 * again. An agent that reports a lost handle cleanly (`team-background-recovery-lost-handle`)
 * gets «Налаштувати заново» here: the delegation is withdrawn on both sides and the page's own
 * setup loop creates a new one. Older agents keep the restart advice; for them the repair
 * would park the space as «retiring».
 */
export function CatalogBackgroundStalledNote({
  teamId,
  onRetried
}: {
  teamId: string;
  onRetried?: () => void;
}) {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  if (agent?.connection !== 'connected')
    return (
      <span className="catalog-background-stalled" role="status">
        {t('catalogVideoCreationWaitingAgent')}
      </span>
    );
  if (!agent.capabilities?.includes('team-background-recovery-lost-handle'))
    return (
      <span className="catalog-background-stalled" role="status">
        {t('catalogBackgroundStalledRetried')}
      </span>
    );
  const repair = async () => {
    setRepairing(true);
    setRepairError(null);
    try {
      await disableBackgroundRecovery(teamId);
      onRetried?.();
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
    <span className="catalog-background-stalled" role="status">
      {t('catalogBackgroundStalled')}
      {repairError ? ` ${teamErrorMessageFor({ code: repairError }, t)}` : ''}{' '}
      <Button variant="outline" size="sm" disabled={repairing} onClick={() => void repair()}>
        {t(repairing ? 'backgroundRecoveryRepairing' : 'backgroundRecoveryRepair')}
      </Button>
    </span>
  );
}
