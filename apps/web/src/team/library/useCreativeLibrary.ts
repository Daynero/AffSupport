import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryAssetSummary, LibraryStage } from '@video-compressor/shared';
import { teamApi } from '../../api/team';

export interface CreativeLibraryListClient {
  listLibraryMaterials(input: {
    teamId: string;
    stage: LibraryStage;
    cursor?: string | null;
    pageSize?: number;
  }): Promise<LibraryAssetSummary[]>;
}

const defaultClient: CreativeLibraryListClient = teamApi;

function mergeAssets(
  current: LibraryAssetSummary[],
  incoming: LibraryAssetSummary[],
  prepend = false
): LibraryAssetSummary[] {
  const byId = new Map<string, LibraryAssetSummary>();
  const sequence = prepend ? [...incoming, ...current] : [...current, ...incoming];
  for (const asset of sequence) {
    if (!byId.has(asset.id)) byId.set(asset.id, asset);
  }
  return [...byId.values()];
}

export function useCreativeLibrary({
  teamId,
  stage,
  revision = 0,
  client = defaultClient,
  pageSize = 50
}: {
  teamId: string;
  stage: LibraryStage;
  revision?: number;
  client?: CreativeLibraryListClient;
  pageSize?: number;
}) {
  const [items, setItems] = useState<LibraryAssetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    try {
      const next = await client.listLibraryMaterials({ teamId, stage, pageSize });
      if (requestGeneration !== generation.current) return;
      setItems(next);
      setHasMore(next.length === pageSize);
      setError(null);
    } catch (cause) {
      if (requestGeneration === generation.current) {
        setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
      }
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [client, pageSize, stage, teamId]);

  useEffect(() => {
    setItems([]);
    void loadFirstPage();
    return () => {
      generation.current += 1;
    };
  }, [loadFirstPage, revision]);

  const loadMore = useCallback(async () => {
    const cursor = items.at(-1)?.id;
    if (!cursor || loading || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const next = await client.listLibraryMaterials({ teamId, stage, cursor, pageSize });
      setItems(current => mergeAssets(current, next));
      setHasMore(next.length === pageSize);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
    } finally {
      setLoadingMore(false);
    }
  }, [client, hasMore, items, loading, loadingMore, pageSize, stage, teamId]);

  const insertOptimistic = useCallback((asset: LibraryAssetSummary) => {
    setItems(current => mergeAssets(current, [asset], true));
  }, []);

  const remove = useCallback((materialIds: readonly string[]) => {
    const removing = new Set(materialIds);
    setItems(current => current.filter(asset => !removing.has(asset.id)));
  }, []);

  return useMemo(
    () => ({
      items,
      loading,
      loadingMore,
      error,
      hasMore,
      refetch: loadFirstPage,
      loadMore,
      insertOptimistic,
      remove
    }),
    [error, hasMore, insertOptimistic, items, loadFirstPage, loadMore, loading, loadingMore, remove]
  );
}
