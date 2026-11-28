import { useEffect, useState } from 'react';
import type { SpaceStorageCategory } from '@video-compressor/shared';
import { ErrorState, LoadingState, StorageMeter } from '../../components/ui/index';
import {
  STORAGE_CATEGORY_LABEL,
  STORAGE_LEVEL_LABEL,
  storageLevelOf,
  useSpaceStorage,
  useStorageWords,
  type SpaceStorageClient
} from './useSpaceStorage';
import {
  StorageItemsList,
  type StorageItemsClient,
  type StorageItemTarget
} from './StorageItemsList';

/** The phone's width, where the scale takes its compact form (breakpoint `sm`). */
const COMPACT_QUERY = '(max-width: 640px)';

function useCompact(forced?: boolean): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(COMPACT_QUERY).matches
      : false
  );
  useEffect(() => {
    if (forced !== undefined || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COMPACT_QUERY);
    const follow = () => setMatches(query.matches);
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [forced]);
  return forced ?? matches;
}

/**
 * 057 T057: the memory of an R2 space (US9) — the scale, and under it the list of whichever
 * category was chosen, biggest first. Shown where a person looks at the space's state and in
 * its settings beside the tariff; the same component in both, so the two never disagree.
 */
export function StorageMeterPanel({
  teamId,
  client,
  itemsClient,
  initialCategory = null,
  compact,
  onOpenItem,
  canDelete = false
}: {
  teamId: string;
  client?: SpaceStorageClient;
  itemsClient?: StorageItemsClient;
  initialCategory?: SpaceStorageCategory | null;
  /** Forces the form; otherwise the viewport decides. */
  compact?: boolean;
  onOpenItem?: (item: StorageItemTarget) => void;
  canDelete?: boolean;
}) {
  const words = useStorageWords();
  const { t } = words;
  const { summary, failed, reload } = useSpaceStorage(teamId, client ? { client } : {});
  const [category, setCategory] = useState<SpaceStorageCategory | null>(initialCategory);
  const narrow = useCompact(compact);

  if (!summary)
    return failed ? (
      <ErrorState
        message={t('spaceStorageLoadFailed')}
        onRetry={reload}
        retryLabel={t('tryAgain')}
      />
    ) : (
      <LoadingState shape="row" count={2} label={t('spaceStorageTitle')} />
    );

  const level = storageLevelOf(summary);
  return (
    <div className="space-storage-panel" data-testid="space-storage-panel">
      <StorageMeter
        compact={narrow}
        level={level}
        segments={summary.segments.map(segment => ({
          category: segment.category,
          label: t(STORAGE_CATEGORY_LABEL[segment.category]),
          bytes: Number(segment.bytes)
        }))}
        reservedBytes={Number(summary.reservedBytes)}
        capacityBytes={Number(summary.capacityBytes)}
        formatBytes={words.bytes}
        formatShare={words.share}
        selected={category}
        onSelect={next => setCategory(current => (current === next ? null : next))}
        labels={{
          name: t('spaceStorageTitle'),
          summary: words.summaryLine(summary),
          reserved: t('spaceStorageReserved'),
          free: t('spaceStorageFree'),
          ...(level === 'ok' ? {} : { level: t(STORAGE_LEVEL_LABEL[level]) })
        }}
      />
      {summary.poolBytes > 0n && (
        <p className="space-storage-panel-note">
          {t('spaceStoragePool', { size: words.bytes(summary.poolBytes) })}
        </p>
      )}
      {category && (
        <StorageItemsList
          key={category}
          teamId={teamId}
          category={category}
          revision={summary.revision}
          {...(itemsClient ? { client: itemsClient } : {})}
          {...(onOpenItem ? { onOpen: onOpenItem } : {})}
          canDelete={canDelete}
          categoryBytes={
            summary.segments.find(segment => segment.category === category)?.bytes ?? 0n
          }
          onChanged={reload}
        />
      )}
    </div>
  );
}
