import { useRef } from 'react';
import type { CatalogRegistryRow } from '../../api/team';
import { useI18n, type TranslationKey } from '../../i18n';
import { catalogRowProgress } from './CatalogProgressRow';

/** The stages of one update, in the order they happen. */
const STAGE_ORDER: readonly TranslationKey[] = [
  'catalogRunVideoWaiting',
  'catalogUpdaterVideoWaiting',
  'catalogRunPreparingVideo',
  'catalogUpdaterStagePreparing',
  'catalogUpdaterStageRefreshing',
  'catalogUpdaterStageBuilding',
  'catalogUpdaterStageUploading',
  'catalogUpdaterStageVerifying',
  'catalogUpdaterStageFinalizing'
];

/**
 * Within one attempt a stage only moves forward. Polls of a running round can
 * briefly read an earlier stage (a profile that lags the round, a verification
 * flag that clears and returns); showing each read made the row flicker
 * between «Перевіряємо таблицю…» and an earlier wording. A new attempt starts over.
 */
export function useSteadyStage(identity: string, label: TranslationKey): TranslationKey {
  const shown = useRef({ identity, label });
  if (shown.current.identity !== identity) shown.current = { identity, label };
  else {
    const previous = STAGE_ORDER.indexOf(shown.current.label);
    const next = STAGE_ORDER.indexOf(label);
    if (previous === -1 || next === -1 || next >= previous) shown.current = { identity, label };
  }
  return shown.current.label;
}

/** Whether the round itself reports where it is, rather than leaving the profile to guess. */
function roundReportsStage(row: CatalogRegistryRow): boolean {
  return (
    Boolean(row.updateStage) ||
    Boolean(
      row.videoGeneration &&
      ['accepted', 'preparing', 'cancel_requested'].includes(row.videoGeneration.state)
    ) ||
    Boolean(row.profile?.reconciliationRequired && row.profile.lastResult === 'running')
  );
}

/**
 * The visible stage of a running update, read from the round rather than the profile. The
 * profile's wording is only the fallback while the round has not reported a stage yet.
 */
export function CatalogRowStage({
  row,
  fallback
}: {
  row: CatalogRegistryRow;
  fallback: TranslationKey;
}) {
  const { t } = useI18n();
  const live = catalogRowProgress(row);
  const label = useSteadyStage(
    `${row.catalogId}:${row.videoGeneration?.setId ?? row.activeAttemptId ?? row.activeRoundAt ?? ''}`,
    live.active && roundReportsStage(row) ? live.label : fallback
  );
  return <span className="catalog-row-stage">{t(label)}</span>;
}
