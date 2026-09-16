import type { MouseEvent } from 'react';
import { catalogCountKey, useI18n } from '../../i18n';
import type { CatalogUpdaterState } from '../../api/team';
import { UpdaterCountdown } from './UpdaterCountdown';
import { WorkspaceChip } from '../workspace/WorkspaceChip';

/**
 * The catalog updater beside the space settings (023, US3).
 *
 * While it runs: that it runs, the time to the next round, how many catalogs, and a warning tone
 * when a sheet keeps failing. While it does not: a plain link into the updater, the same size as
 * the space-settings link next to it, so the header does not jump when it starts.
 */
export function CatalogUpdaterChip({
  state,
  offsetMs,
  href,
  onNavigate
}: {
  state: CatalogUpdaterState | null;
  offsetMs: number;
  href: string;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { t, language } = useI18n();

  if (!state || state.state !== 'running') {
    return (
      <a className="team-space-shell-utility-link" href={href} onClick={onNavigate}>
        {t('catalogUpdaterEntry')}
      </a>
    );
  }

  const attention = state.failingCount > 0;
  const catalogs = t(catalogCountKey(language, state.catalogCount), { count: state.catalogCount });
  return (
    <WorkspaceChip
      tone={attention ? 'warn' : 'busy'}
      busy={!attention}
      className="team-updater-chip"
      href={href}
      onPress={onNavigate}
      label={`${t('catalogUpdaterChipOpen')}: ${catalogs}`}
    >
      <span>{t('catalogUpdaterChipLabel')}</span>
      <UpdaterCountdown
        targetIso={state.nextRunAt}
        offsetMs={offsetMs}
        dueLabel={t('catalogUpdaterChipDue')}
      />
      <span>{catalogs}</span>
      {state.restitch && state.spareReadyCount !== null && (
        <span>
          {t('catalogUpdaterChipSpares', {
            ready: state.spareReadyCount,
            count: state.catalogCount
          })}
        </span>
      )}
      {attention && <span>{t('catalogUpdaterChipAttention')}</span>}
    </WorkspaceChip>
  );
}
