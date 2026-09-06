import { useCallback, useEffect, useRef, useState } from 'react';
import { isHousekeepingFile } from '../catalog/housekeeping';
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
  /**
   * Replaces one row in place — for a change the caller already knows the
   * result of, like a tag. Re-reading the whole folder to repaint one dot
   * would lose the scroll of a folder somebody is halfway down.
   */
  patchRow: (id: string, patch: Partial<TeamMaterialRow>) => void;
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

  /** How many rows the filter has taken out of the count so far. */
  const hiddenSoFar = useRef(0);

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
        const kept = page.rows.filter(row => !isHousekeepingFile(row.name));
        /*
         * Housekeeping files are hidden from the list, so they must come off the
         * count too — and they come off cumulatively. Subtracting only this
         * page's hidden rows from the whole-folder total meant the number moved
         * as a person scrolled, and settled on whatever the last page happened
         * to hide.
         */
        hiddenSoFar.current = replace
          ? page.rows.length - kept.length
          : hiddenSoFar.current + (page.rows.length - kept.length);
        setRows(current => (replace ? kept : [...current, ...kept]));
        setTotal(Math.max(0, page.total - hiddenSoFar.current));
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

  const patchRow = useCallback((id: string, patch: Partial<TeamMaterialRow>) => {
    setRows(current => current.map(row => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  return {
    rows,
    total,
    loading,
    error,
    hasMore: next !== null,
    loadMore: () => (next ? fetchPage(next, false) : Promise.resolve()),
    reload: () => fetchPage(null, true),
    patchRow
  };
}
