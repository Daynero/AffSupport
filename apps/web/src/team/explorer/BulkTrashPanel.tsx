import { useEffect, useRef } from 'react';
import type { BulkTrashGroup, TeamMaterialRow } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { ProcessPanel } from './ProcessPanel';

/** Delivery is acknowledged only by the mounted, visible result surface. */
export function BulkTrashPanel({
  group,
  rows,
  uncertain,
  onRetry,
  onVisible,
  onDismiss
}: {
  group: BulkTrashGroup;
  rows: readonly Pick<TeamMaterialRow, 'id' | 'name'>[];
  uncertain: boolean;
  onRetry?: () => void;
  onVisible: (id: string) => void;
  onDismiss?: (id: string) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const complete = group.items.every(item => item.state === 'confirmed');
  useEffect(() => {
    const node = root.current;
    if (!node || !complete) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = () => {
      if (document.visibilityState === 'visible' && !node.closest('[hidden]')) {
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
  }, [complete, group.id, onVisible, onDismiss]);
  const confirmed = group.items.filter(item => item.state === 'confirmed').length;
  const unresolved = group.items.some(item => ['failed', 'unknown', 'queued'].includes(item.state));
  return (
    <div ref={root}>
      <ProcessPanel
        title={t('teamBulkTrashTitle')}
        onDismiss={onDismiss ? () => onDismiss(group.id) : undefined}
        dismissLabel={t('teamBulkTrashHide')}
        detail={t('teamWorkspaceItemsProgress', { done: confirmed, total: group.items.length })}
        phase={uncertain ? t('teamBulkTrashUnknown') : null}
        progress={group.items.length ? (confirmed / group.items.length) * 100 : 100}
        active={group.items.some(item => item.state === 'running' || item.state === 'queued')}
        actions={
          complete && onDismiss
            ? [{ label: t('teamOperationClose'), run: () => onDismiss(group.id) }]
            : unresolved && onRetry
              ? [{ label: t('retry'), run: onRetry }]
              : []
        }
      >
        <ul className="m-0 grid max-h-64 min-w-0 list-none gap-2 overflow-y-auto p-0">
          {group.items.map((item, index) => (
            <li key={item.materialId} className="min-w-0">
              <span
                className="block min-w-0 truncate"
                title={rows.find(row => row.id === item.materialId)?.name}
              >
                {rows.find(row => row.id === item.materialId)?.name ??
                  t('teamBulkTrashFile', { number: index + 1 })}
              </span>
              <span className="block break-words text-caption text-muted">
                {t(
                  item.state === 'confirmed'
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
