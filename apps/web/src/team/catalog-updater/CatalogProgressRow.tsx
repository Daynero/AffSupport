import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import type { CatalogRegistryRow } from '../../api/team';
import { useI18n, type TranslationKey } from '../../i18n';

const STAGES = {
  preparing: [0.12, 'catalogUpdaterStagePreparing'],
  refreshing: [0.5, 'catalogUpdaterStageRefreshing'],
  building: [0.66, 'catalogUpdaterStageBuilding'],
  uploading: [0.82, 'catalogUpdaterStageUploading'],
  verifying: [0.94, 'catalogUpdaterStageVerifying'],
  finalizing: [0.98, 'catalogUpdaterStageFinalizing']
} as const;

/** Stage-based fill, never a timer pretending that a background operation advanced. */
export function catalogRowProgress(row: CatalogRegistryRow): {
  active: boolean;
  value: number;
  label: TranslationKey;
} {
  const verifying = row.profile?.reconciliationRequired && row.profile.lastResult === 'running';
  if (verifying) return { active: true, value: 0.94, label: 'catalogUpdaterStageVerifying' };
  if (!row.updatePending) return { active: false, value: 0, label: 'catalogUpdaterUpdatingNow' };
  if (row.updateStage === 'waiting_video')
    return { active: true, value: 0.04, label: 'catalogUpdaterVideoWaiting' };
  if (row.updateStage === 'restitching')
    return {
      active: true,
      value:
        0.08 +
        Math.max(
          0,
          Math.min(100, Number.isFinite(row.restitchProgress) ? row.restitchProgress! : 0)
        ) *
          0.0032,
      label: 'catalogRunPreparingVideo'
    };
  const stage =
    row.updateStage && row.updateStage in STAGES
      ? STAGES[row.updateStage as keyof typeof STAGES]
      : STAGES.preparing;
  return { active: true, value: stage[0], label: stage[1] };
}

export function CatalogProgressRow({
  row,
  children,
  className,
  onAnimationEnd,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { row: CatalogRegistryRow }) {
  const { t } = useI18n();
  const current = catalogRowProgress(row);
  const last = useRef({ active: current.active, success: row.profile?.lastSuccessfulAt });
  const [fill, setFill] = useState(current.value);
  const [complete, setComplete] = useState(false);
  const success = row.profile?.lastSuccessfulAt;
  const confirmed = !row.profile?.reconciliationRequired && row.profile?.lastResult === 'success';
  useEffect(() => {
    const wasActive = last.current.active;
    const finished =
      confirmed &&
      Boolean(success) &&
      success !== last.current.success &&
      (wasActive || last.current.success !== undefined);
    if (finished) {
      setFill(1);
      setComplete(true);
    } else if (current.active) {
      setFill(previous => (wasActive ? Math.max(previous, current.value) : current.value));
      setComplete(false);
    } else if (!complete) setFill(0);
    last.current = { active: current.active, success };
  }, [current.active, current.value, confirmed, success, complete]);
  return (
    <tr
      {...props}
      className={[className, 'catalog-progress-row', complete ? 'is-update-complete' : '']
        .filter(Boolean)
        .join(' ')}
      aria-busy={current.active || undefined}
      data-tip={current.active ? t(current.label) : undefined}
      style={
        {
          ...props.style,
          '--catalog-row-progress': fill,
          '--catalog-row-progress-visible': current.active || complete ? 1 : 0
        } as CSSProperties
      }
      onAnimationEnd={event => {
        if (
          (event.target === event.currentTarget ||
            event.target === event.currentTarget.firstElementChild) &&
          event.animationName === 'catalog-row-complete'
        )
          setComplete(false);
        onAnimationEnd?.(event);
      }}
    >
      {children}
    </tr>
  );
}
