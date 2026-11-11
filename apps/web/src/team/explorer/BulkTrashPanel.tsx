import { useEffect, useRef } from 'react';
import type {
  BulkTrashGroup,
  TeamMaterialRow,
  TeamHistoricalFileReceipt
} from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { ProcessPanel } from './ProcessPanel';

/** Delivery is acknowledged only by the mounted, visible result surface. */
export function BulkTrashPanel({
  group,
  rows,
  uncertain,
  historicalReceipts,
  names,
  executing = false,
  onRetry,
  onVisible,
  onDismiss
}: {
  group: BulkTrashGroup;
  rows: readonly Pick<TeamMaterialRow, 'id' | 'name'>[];
  uncertain: boolean;
  historicalReceipts?: ReadonlyMap<string, TeamHistoricalFileReceipt>;
  /** Names remembered when the work started, for rows this surface does not list. */
  names?: ReadonlyMap<string, string>;
  /** This tab is working through the group now; queued items are progress, not a stall. */
  executing?: boolean;
  onRetry?: () => void;
  onVisible: (id: string, outcome?: 'unknown') => void;
  onDismiss?: (id: string) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const complete =
    !historicalReceipts?.size && group.items.every(item => item.state === 'confirmed');
  const reportedHistorical = useRef<string | null>(null);
  const historicalFingerprint = historicalReceipts?.size
    ? JSON.stringify(
        [...historicalReceipts].map(([id, receipt]) => [
          id,
          receipt.state,
          receipt.matchingCount,
          receipt.missingCount
        ])
      )
    : null;
  useEffect(() => {
    const node = root.current;
    if (!node || (!complete && !historicalFingerprint)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = () => {
      if (document.visibilityState === 'visible' && !node.closest('[hidden]')) {
        if (historicalFingerprint) {
          const fingerprint = group.id + historicalFingerprint;
          if (reportedHistorical.current !== fingerprint) {
            reportedHistorical.current = fingerprint;
            onVisible(group.id, 'unknown');
          }
          return;
        }
        onVisible(group.id);
        if (onDismiss && timer === undefined) timer = setTimeout(() => onDismiss(group.id), 4000);
      }
    };
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) seen();
          });
    if (observer) observer.observe(node);
    else seen();
    const foreground = () => {
      if (node.getBoundingClientRect().height > 0) seen();
    };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [complete, historicalFingerprint, group.id, onVisible, onDismiss]);
  const confirmed = group.items.filter(
    item => item.state === 'confirmed' && !historicalReceipts?.has(item.materialId)
  ).length;
  const unresolved =
    Boolean(historicalReceipts?.size) ||
    (!executing && group.items.some(item => ['failed', 'unknown', 'queued'].includes(item.state)));
  const nameOf = (id: string) => rows.find(row => row.id === id)?.name || names?.get(id);
  return (
    <div ref={root}>
      <ProcessPanel
        title={t('teamBulkTrashTitle')}
        onDismiss={onDismiss ? () => onDismiss(group.id) : undefined}
        dismissLabel={t('teamBulkTrashHide')}
        detail={t('teamWorkspaceItemsProgress', { done: confirmed, total: group.items.length })}
        phase={uncertain || historicalReceipts?.size ? t('teamBulkTrashUnknown') : null}
        progress={group.items.length ? (confirmed / group.items.length) * 100 : 100}
        active={
          // Queued items nobody is working through are held, not moving.
          executing || group.items.some(item => item.state === 'running')
        }
        actions={
          complete && onDismiss
            ? [{ label: t('teamOperationClose'), run: () => onDismiss(group.id) }]
            : unresolved && onRetry
              ? [
                  {
                    label: t(historicalReceipts?.size ? 'catalogCommandCheck' : 'retry'),
                    run: onRetry
                  }
                ]
              : []
        }
      >
        <ul className="m-0 grid max-h-64 min-w-0 list-none gap-2 overflow-y-auto p-0">
          {group.items.map((item, index) => (
            <li key={item.materialId} className="min-w-0">
              <span className="block min-w-0 truncate" title={nameOf(item.materialId)}>
                {nameOf(item.materialId) ?? t('teamBulkTrashFile', { number: index + 1 })}
              </span>
              <span className="block break-words text-caption text-muted">
                {t(
                  historicalReceipts?.get(item.materialId)?.state === 'matches'
                    ? 'teamBulkTrashHistoricalMatches'
                    : historicalReceipts?.get(item.materialId)?.state === 'changed'
                      ? 'teamBulkTrashHistoricalChanged'
                      : historicalReceipts?.has(item.materialId)
                        ? 'teamBulkTrashHistoricalUnknown'
                        : item.state === 'confirmed'
                          ? 'teamBulkTrashConfirmed'
                          : item.state === 'running'
                            ? 'teamBulkTrashRunning'
                            : item.state === 'queued'
                              ? 'teamBulkTrashQueued'
                              : item.state === 'failed'
                                ? 'teamBulkTrashFailed'
                                : 'teamBulkTrashUnknown'
                )}
                {item.errorCode ? ` · ${teamErrorMessageFor({ code: item.errorCode }, t)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </ProcessPanel>
    </div>
  );
}
