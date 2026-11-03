import { useCallback, useEffect, useRef, useState } from 'react';
import { settleRead, type ReadResult } from './readSettle';
import { useOptionalTeam } from '../TeamContext';
import { useOptionalAuth } from '../../auth/AuthContext';
import { createReadCoordinator, withReadDeadline } from '../readCoordinator';
import { isHousekeepingFile } from '../catalog/housekeeping';
import { useCatalogRead } from '../catalog/CatalogFreshness';
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
      signal?: AbortSignal;
    }
  ) => Promise<FolderPage>;
}

const PAGE_SIZE = 100;
const FOLDER_PAGE_TIMEOUT_MS = 12_000;
const EMPTY_ROWS: TeamMaterialRow[] = [];

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
  /** A transient empty read must not erase already displayed rows during an incomplete scan. */
  preserveOnEmpty?: boolean;
  beforeRowsReplace?: () => void;
}): FolderPageState {
  const {
    teamId,
    client,
    parentFolderId,
    kinds,
    revision = 0,
    preserveOnEmpty = false,
    beforeRowsReplace
  } = input;
  const kindsKey = (kinds ?? []).join(',');
  const actor = useOptionalAuth()?.user?.id ?? null;
  const access = useOptionalTeam();
  const scopeKey = JSON.stringify([
    actor,
    teamId,
    access?.accessRevision,
    access?.activeTeam?.permissions,
    parentFolderId,
    kindsKey
  ]);
  const activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;
  const beginRead = useCatalogRead(teamId);
  const [rows, setRows] = useState<TeamMaterialRow[]>([]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [dataScope, setDataScope] = useState(scopeKey);
  const dataScopeRef = useRef(dataScope);
  dataScopeRef.current = dataScope;
  const preserveOnEmptyRef = useRef(preserveOnEmpty);
  preserveOnEmptyRef.current = preserveOnEmpty;
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<FolderPageCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const latestRefresh = useRef<Promise<ReadResult> | null>(null);
  const loadedPages = useRef(1);
  const appendRead = useRef<Promise<void> | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const beforeRowsReplaceRef = useRef(beforeRowsReplace);
  beforeRowsReplaceRef.current = beforeRowsReplace;

  /** How many rows the filter has taken out of the count so far. */
  const hiddenSoFar = useRef(0);

  const fetchPage = useCallback(
    async (after: FolderPageCursor | null, replace: boolean, reportFailure = false) => {
      if (activeScope.current !== scopeKey) return;
      const read = beginRead();
      const token = ++generation.current;
      setLoading(true);
      try {
        const controller = new AbortController();
        controllers.current.add(controller);
        const page = await withReadDeadline(
          signal =>
            client.listFolderPage(teamId, {
              parentFolderId,
              ...(kinds && kinds.length > 0 ? { kinds } : {}),
              after,
              limit: PAGE_SIZE,
              signal
            }),
          controller.signal,
          FOLDER_PAGE_TIMEOUT_MS
        ).finally(() => controllers.current.delete(controller));
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
        setDataScope(scopeKey);
        if (!replace) loadedPages.current += 1;
        setError(false);
        read.succeed();
      } catch {
        read.fail();
        if (token === generation.current) setError(true);
        if (reportFailure) throw new Error('FOLDER_PAGE_REFRESH_FAILED');
      } finally {
        if (token === generation.current) setLoading(false);
      }
    },
    // kindsKey stands in for the array identity.
    [client, teamId, parentFolderId, kindsKey, scopeKey, beginRead]
  );

  const performRefresh = useCallback(
    async (reportFailure = false) => {
      const read = beginRead();
      const token = ++generation.current;
      const targetPages = loadedPages.current;
      setLoading(true);
      const attemptRead = (async (): Promise<ReadResult> => {
        try {
          // A transient catalog read must not replace a previously loaded
          // window with an empty first page. Retry the whole window, not only the
          // failed page, so every committed render comes from one fresh walk.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              let cursor: FolderPageCursor | null = null;
              let totalRows = 0;
              let hidden = 0;
              let pagesRead = 0;
              const visible: TeamMaterialRow[] = [];
              for (let index = 0; index < targetPages; index += 1) {
                const controller = new AbortController();
                controllers.current.add(controller);
                const page: FolderPage = await withReadDeadline(
                  signal =>
                    client.listFolderPage(teamId, {
                      parentFolderId,
                      ...(kinds && kinds.length > 0 ? { kinds } : {}),
                      after: cursor,
                      limit: PAGE_SIZE,
                      signal
                    }),
                  controller.signal,
                  FOLDER_PAGE_TIMEOUT_MS
                ).finally(() => controllers.current.delete(controller));
                if (token !== generation.current) return 'superseded';
                const kept = page.rows.filter(row => !isHousekeepingFile(row.name));
                visible.push(...kept);
                hidden += page.rows.length - kept.length;
                totalRows = page.total;
                cursor = page.next;
                pagesRead += 1;
                if (!cursor) break;
              }
              // A folder being discovered can briefly answer with zero rows
              // between catalog commits. Keep its last visible window until a
              // completed/strict read confirms the true empty result.
              if (!(
                preserveOnEmptyRef.current &&
                !reportFailure &&
                visible.length === 0 &&
                dataScopeRef.current === scopeKey &&
                rowsRef.current.length > 0
              )) {
                hiddenSoFar.current = hidden;
                loadedPages.current = pagesRead;
                beforeRowsReplaceRef.current?.();
                setRows(visible);
                setTotal(Math.max(0, totalRows - hidden));
                setNext(cursor);
              }
              setDataScope(scopeKey);
              setError(false);
              read.succeed();
              return 'ok';
            } catch {
              if (token !== generation.current) return 'superseded';
              if (attempt === 1) {
                read.fail();
                setError(true);
                return 'failed';
              }
              await new Promise(resolve => window.setTimeout(resolve, 250));
              if (token !== generation.current) return 'superseded';
            }
          }
          return 'failed';
        } finally {
          if (token === generation.current) setLoading(false);
        }
      })();
      latestRefresh.current = attemptRead;
      const result = await settleRead(attemptRead, latestRefresh);
      if (!reportFailure) return;
      // The read that painted the folder answers for the one it replaced (028).
      if (result === 'failed') throw new Error('FOLDER_PAGE_REFRESH_FAILED');
      if (result === 'superseded') throw new Error('CATALOG_REFRESH_SUPERSEDED');
    },
    [client, teamId, parentFolderId, kindsKey, scopeKey, beginRead]
  );

  const strictPending = useRef(false);
  const refreshRef = useRef(performRefresh);
  refreshRef.current = performRefresh;
  const coordinator = useRef<ReturnType<typeof createReadCoordinator> | null>(null);
  const refreshWindow = useCallback(
    async (strict = false) => {
      if (activeScope.current !== scopeKey) {
        if (strict) throw new Error('CATALOG_REFRESH_SUPERSEDED');
        return;
      }
      strictPending.current ||= strict;
      const owner = coordinator.current;
      await appendRead.current;
      if (owner !== coordinator.current) {
        if (strict) throw new Error('CATALOG_REFRESH_SUPERSEDED');
        return;
      }
      try {
        await owner?.request();
        if (strict && owner !== coordinator.current) throw new Error('CATALOG_REFRESH_SUPERSEDED');
      } finally {
        if (owner === coordinator.current && !owner?.isRunning()) strictPending.current = false;
      }
    },
    [scopeKey]
  );

  useEffect(() => {
    const owner = createReadCoordinator(async () => {
      const strict = strictPending.current;
      await refreshRef.current(strict);
    });
    coordinator.current = owner;
    setRows([]);
    setTotal(null);
    setNext(null);
    loadedPages.current = 1;
    const visible = () => {
      if (document.visibilityState !== 'hidden') void refreshWindow();
    };
    if (document.visibilityState !== 'hidden') void refreshWindow();
    document.addEventListener('visibilitychange', visible);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      owner.stop();
      if (coordinator.current === owner) coordinator.current = null;
      generation.current += 1;
      appendRead.current = null;
      strictPending.current = false;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [performRefresh, refreshWindow]);

  useEffect(() => {
    if (revision === 0 || document.visibilityState === 'hidden') return;
    void refreshWindow();
  }, [refreshWindow, revision]);

  const patchRow = useCallback(
    (id: string, patch: Partial<TeamMaterialRow>) => {
      if (activeScope.current !== scopeKey) return;
      setRows(current => current.map(row => (row.id === id ? { ...row, ...patch } : row)));
      if (coordinator.current?.isRunning()) {
        generation.current += 1;
        void refreshWindow();
      }
    },
    [scopeKey, refreshWindow]
  );

  return {
    rows: dataScope === scopeKey ? rows : EMPTY_ROWS,
    total: dataScope === scopeKey ? total : null,
    loading: loading || dataScope !== scopeKey,
    error: dataScope === scopeKey && error,
    hasMore: dataScope === scopeKey && next !== null,
    loadMore: () => {
      if (appendRead.current) return appendRead.current;
      if (dataScope !== scopeKey || !next || loading || coordinator.current?.isRunning())
        return Promise.resolve();
      const pending = fetchPage(next, false).finally(() => {
        if (appendRead.current === pending) appendRead.current = null;
      });
      appendRead.current = pending;
      return pending;
    },
    reload: () => refreshWindow(),
    reloadStrict: () => refreshWindow(true),
    patchRow
  };
}
