import { useState } from 'react';
import { PauseCircle } from 'lucide-react';
import { spaceTariffApi } from '../../api/team';
import { useToasts } from '../../components/toast';
import { Alert, Button } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { useOptionalSpaceAccess } from './useSpaceAccess';

/**
 * The catalog updater stayed off after the pause (034, US6.6, R7).
 *
 * A renewal opens the space, but it does not switch the updater back on by
 * itself: catalogs that had been updating hourly would otherwise all fire at
 * once in the first minute. Each catalog kept its interval; one press puts them
 * all back, with the first update straight away.
 *
 * For whoever may run the updater, and for nobody else — a line a person
 * cannot act on is not theirs to read.
 */
export function UpdaterResumeNotice({
  teamId,
  onResumed,
  resume = id => spaceTariffApi.resumeCatalogUpdater(id),
  compact = false
}: {
  teamId: string;
  onResumed?: () => void;
  resume?: (teamId: string) => Promise<boolean>;
  /** Inside the updater's own panel: the same line, quieter. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can } = useTeam();
  const spaceAccess = useOptionalSpaceAccess();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const paused =
    spaceAccess?.access?.teams.find(team => team.teamId === teamId)?.tariff
      .updaterPausedByTariff === true;

  if (!paused || done || !can('process')) return null;

  const turnOn = async () => {
    setBusy(true);
    try {
      await resume(teamId);
      setDone(true);
      push({ tone: 'success', text: t('tariffUpdaterResumed') });
      onResumed?.();
      spaceAccess?.recheck();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Alert
      className={compact ? 'tariff-updater-notice is-compact' : 'tariff-updater-notice'}
      color="info"
      variant={compact ? 'subtle' : 'soft'}
      icon={<PauseCircle size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
      action={
        <Button
          size="sm"
          color="primary"
          variant="soft"
          loading={busy}
          onClick={() => void turnOn()}
        >
          {t('tariffUpdaterResume')}
        </Button>
      }
    >
      {t('tariffUpdaterPaused')}
    </Alert>
  );
}
