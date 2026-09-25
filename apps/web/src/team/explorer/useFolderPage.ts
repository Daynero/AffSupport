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
 * what has already been shown. A revision bump re-reads the loaded window.
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
const FOLDER_PAGE_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: number | undefined;
  return Promise.race([
    promise,
    new Promise<T>(
      (_, reject) =>
        (timer = window.setTimeout(() => reject(new Error('FOLDER_PAGE_TIMEOUT')), milliseconds))
    )
  ]).finally(() => window.clearTimeout(timer));
}

export interface FolderPageState {
  rows: TeamMaterialRow[];
  total: number | null;
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
  reloadStrict: () => Promise<void>;
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
  beforeRowsReplace?: () => void;
}): FolderPageState {
  const { teamId, client, parentFolderId, kinds, revision = 0, beforeRowsReplace } = input;
  const [rows, setRows] = useState<TeamMaterialRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<FolderPageCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const loadedPages = useRef(1);
  const beforeRowsReplaceRef = useRef(beforeRowsReplace);
  beforeRowsReplaceRef.current = beforeRowsReplace;
  const kindsKey = (kinds ?? []).join(',');

  /** How many rows the filter has taken out of the count so far. */
  const hiddenSoFar = useRef(0);

  const fetchPage = useCallback(
    async (after: FolderPageCursor | null, replace: boolean, reportFailure = false) => {
      const token = ++generation.current;
      setLoading(true);
      try {
        const page = await withTimeout(
          client.listFolderPage(teamId, {
            parentFolderId,
            ...(kinds && kinds.length > 0 ? { kinds } : {}),
            after,
            limit: PAGE_SIZE
          }),
          FOLDER_PAGE_TIMEOUT_MS
        );
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
        if (replace) beforeRowsReplaceRef.current?.();
        setRows(current => (replace ? kept : [...current, ...kept]));
        setTotal(Math.max(0, page.total - hiddenSoFar.current));
        setNext(page.next);
        if (!replace) loadedPages.current += 1;
        setError(false);
      } catch {
        if (token === generation.current) setError(true);
        if (reportFailure) throw new Error('FOLDER_PAGE_REFRESH_FAILED');
      } finally {
        if (token === generation.current) setLoading(false);
      }
    },
    // kindsKey stands in for the array identity.
    [client, teamId, parentFolderId, kindsKey]
  );

  const refreshWindow = useCallback(
    async (reportFailure = false) => {
      const token = ++generation.current;
      const targetPages = loadedPages.current;
      setLoading(true);
      try {
        // A transient catalog read must not replace a previously loaded
        // window with an empty first page. Retry the whole window, not only the
        // failed page, so every committed render comes from one fresh walk.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            let cursor: FolderPageCursor | null = null;
            let totalRows = 0;
            let hidden = 0;
            let pagesRead = 0;
            const visible: TeamMaterialRow[] = [];
            for (let index = 0; index < targetPages; index += 1) {
              const page: FolderPage = await withTimeout(
                client.listFolderPage(teamId, {
                  parentFolderId,
                  ...(kinds && kinds.length > 0 ? { kinds } : {}),
                  after: cursor,
                  limit: PAGE_SIZE
                }),
                FOLDER_PAGE_TIMEOUT_MS
              );
              if (token !== generation.current) return;
              const kept = page.rows.filter(row => !isHousekeepingFile(row.name));
              visible.push(...kept);
              hidden += page.rows.length - kept.length;
              totalRows = page.total;
              cursor = page.next;
              pagesRead += 1;
              if (!cursor) break;
            }
            hiddenSoFar.current = hidden;
            loadedPages.current = pagesRead;
            beforeRowsReplaceRef.current?.();
            setRows(visible);
            setTotal(Math.max(0, totalRows - hidden));
            setNext(cursor);
            setError(false);
            return;
          } catch {
            if (token !== generation.current) return;
            if (attempt === 2) {
              setError(true);
              if (reportFailure) throw new Error('FOLDER_PAGE_REFRESH_FAILED');
            }
          }
        }
      } finally {
        if (token === generation.current) setLoading(false);
      }
    },
    [client, teamId, parentFolderId, kindsKey]
  );

  useEffect(() => {
    setRows([]);
    setTotal(null);
    setNext(null);
    loadedPages.current = 1;
    void refreshWindow();
  }, [refreshWindow]);

  useEffect(() => {
    if (revision === 0) return;
    void refreshWindow();
  }, [refreshWindow, revision]);

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
    reload: () => refreshWindow(),
    reloadStrict: () => refreshWindow(true),
    patchRow
  };
}
