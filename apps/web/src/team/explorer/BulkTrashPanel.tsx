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
  onVisible
}: {
  group: BulkTrashGroup;
  rows: readonly TeamMaterialRow[];
  uncertain: boolean;
  onRetry?: () => void;
  onVisible: (id: string) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const complete = group.items.every(item => item.state === 'confirmed');
  useEffect(() => {
    const node = root.current;
    if (!node || !complete) return;
    const seen = () => {
      if (document.visibilityState === 'visible' && !node.closest('[hidden]')) onVisible(group.id);
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
      observer?.disconnect();
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [complete, group.id, onVisible]);
  const confirmed = group.items.filter(item => item.state === 'confirmed').length;
  const unresolved = group.items.some(item => ['failed', 'unknown', 'queued'].includes(item.state));
  return (
    <div ref={root}>
      <ProcessPanel
        title={t('teamBulkTrashTitle')}
        detail={t('teamWorkspaceItemsProgress', { done: confirmed, total: group.items.length })}
        phase={uncertain ? t('teamBulkTrashUnknown') : null}
        progress={group.items.length ? (confirmed / group.items.length) * 100 : 100}
        active={group.items.some(item => item.state === 'running' || item.state === 'queued')}
        actions={unresolved && onRetry ? [{ label: t('retry'), run: onRetry }] : []}
      >
        <ul className="max-h-64 overflow-y-auto">
          {group.items.map((item, index) => (
            <li key={item.materialId}>
              {rows.find(row => row.id === item.materialId)?.name ??
                t('teamBulkTrashFile', { number: index + 1 })}{' '}
              ·{' '}
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
            </li>
          ))}
        </ul>
      </ProcessPanel>
    </div>
  );
}
