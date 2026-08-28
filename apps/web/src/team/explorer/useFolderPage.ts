import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FolderPage,
  FolderPageCursor,
  TeamMaterialRow,
  TeamMaterialRowKind
} from '@video-compressor/shared';

/**
 * One folder's rows, a page at a time, from the index (011, FR-009/FR-010).
 * The first screen and the total arrive together; further pages are appended
 * behind a stable keyset cursor, so a row inserted between pages never shifts
 * what has already been shown. A revision bump re-reads the first page.
 */
export interface FolderPageClient {
  listFolderPage: (
    teamId: string,
    input: {
      parentFolderId: string | null;
      kinds?: TeamMaterialRowKind[];
      after?: FolderPageCursor | null;
      limit?: number;
    }
  ) => Promise<FolderPage>;
}

const PAGE_SIZE = 100;

export interface FolderPageState {
  rows: TeamMaterialRow[];
  total: number | null;
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useFolderPage(input: {
  teamId: string;
  client: FolderPageClient;
  parentFolderId: string | null;
  kinds?: TeamMaterialRowKind[];
  revision?: number;
}): FolderPageState {
  const { teamId, client, parentFolderId, kinds, revision = 0 } = input;
  const [rows, setRows] = useState<TeamMaterialRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<FolderPageCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const kindsKey = (kinds ?? []).join(',');

  const fetchPage = useCallback(
    async (after: FolderPageCursor | null, replace: boolean) => {
      const token = ++generation.current;
      setLoading(true);
      try {
        const page = await client.listFolderPage(teamId, {
          parentFolderId,
          ...(kinds && kinds.length > 0 ? { kinds } : {}),
          after,
          limit: PAGE_SIZE
        });
        if (token !== generation.current) return;
        setRows(current => (replace ? page.rows : [...current, ...page.rows]));
        setTotal(page.total);
        setNext(page.next);
        setError(false);
      } catch {
        if (token === generation.current) setError(true);
      } finally {
        if (token === generation.current) setLoading(false);
      }
    },
    // kindsKey stands in for the array identity.
    [client, teamId, parentFolderId, kindsKey]
  );

  useEffect(() => {
    setRows([]);
    setTotal(null);
    setNext(null);
    void fetchPage(null, true);
  }, [fetchPage]);

  useEffect(() => {
    if (revision === 0) return;
    void fetchPage(null, true);
  }, [fetchPage, revision]);

  return {
    rows,
    total,
    loading,
    error,
    hasMore: next !== null,
    loadMore: () => (next ? fetchPage(next, false) : Promise.resolve()),
    reload: () => fetchPage(null, true)
  };
}
