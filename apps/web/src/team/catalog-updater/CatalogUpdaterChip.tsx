import type { MouseEvent } from 'react';
import { CalendarClock, RefreshCw, TriangleAlert } from 'lucide-react';
import { catalogCountKey, useI18n } from '../../i18n';
import type { CatalogUpdaterState } from '../../api/team';
import { useRemaining } from './UpdaterCountdown';
import { WorkspaceChip } from '../workspace/WorkspaceChip';
import { teamErrorMessageFor } from '../errors';
import { Tooltip } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';

/** Scheduled work is waiting, not continuously running. Spare copies are preparation, not progress. */
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
  const remaining = useRemaining(state?.nextRunAt ?? null, offsetMs);
  if (!state || (state.state !== 'running' && !state.activeCount)) {
    return (
      <a
        className="team-space-shell-utility-link inline-flex items-center gap-1"
        href={href}
        onClick={onNavigate}
      >
        <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {t('catalogUpdaterEntry')}
      </a>
    );
  }

  const attention = state.failingCount > 0 || Boolean(state.restitchBlockedCode);
  const oneOff = state.state === 'stopped' || state.nextRunAt === null;
  const active = (state.activeCount ?? 0) > 0;
  const scheduled = !oneOff ? t('catalogChipScheduledCount', { count: state.catalogCount }) : null;
  const titleCount = oneOff ? state.activeCount : state.catalogCount;
  const minutes =
    remaining !== null && Number.isFinite(remaining)
      ? Math.max(1, Math.ceil(remaining / 60000))
      : null;
  const duration =
    minutes === null
      ? null
      : minutes >= 60
        ? t('catalogChipHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
        : t('catalogChipMinutes', { minutes });
  const activeCatalogs = t(catalogCountKey(language, state.activeCount ?? 0), {
    count: state.activeCount ?? 0
  });
  const status = active
    ? t('catalogChipActive', { catalogs: activeCatalogs })
    : attention
      ? t('catalogUpdaterChipAttention')
      : oneOff
        ? t('catalogUpdaterUpdatingNow')
        : remaining === null || !Number.isFinite(remaining)
          ? t('catalogIconsNextUnknown')
          : remaining <= 0
            ? t('catalogChipWaiting')
            : t('catalogChipNext', { time: duration ?? '' });
  const details = [
    scheduled,
    !oneOff && state.restitch && state.spareReadyCount !== null
      ? t('catalogChipReadyVideos', { count: state.spareReadyCount })
      : null,
    state.restitchBlockedCode ? teamErrorMessageFor(new Error(state.restitchBlockedCode), t) : null,
    t('catalogUpdaterChipOpen')
  ]
    .filter(Boolean)
    .join(' · ');
  const Icon = attention ? TriangleAlert : CalendarClock;

  return (
    <Tooltip label={details}>
      <WorkspaceChip
        tone={attention ? 'warn' : 'quiet'}
        busy={active || (oneOff && !attention)}
        className="team-updater-chip"
        href={href}
        onPress={onNavigate}
        label={`${t('catalogUpdaterChipOpen')}: ${scheduled ? `${scheduled}. ` : ''}${status}`}
      >
        {!(active || (oneOff && !attention)) && (
          <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        )}
        <span className="catalog-chip-copy">
          <span className="catalog-chip-title">
            {t(oneOff ? 'catalogChipOneOffTitle' : 'catalogChipTitle')}
            {typeof titleCount === 'number' && (
              <span className="catalog-chip-count">{titleCount}</span>
            )}
          </span>
          <span className="catalog-chip-status">{status}</span>
        </span>
      </WorkspaceChip>
    </Tooltip>
  );
}
