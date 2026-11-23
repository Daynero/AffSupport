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

/**
 * Folders already read in this session, as they were last shown (058).
 *
 * Going back to a folder used to start from nothing: the list was emptied,
 * read again, and shown when the answer came — half a second of the previous
 * folder, or of a placeholder, on every step between two folders someone is
 * comparing. A folder seen before is now shown at once as it was, and the same
 * read that always ran brings it up to date underneath.
 *
 * Kept per client, so nothing outlives the session that read it, and under the
 * hook's own scope key — who is asking, with which rights, for which folder
 * and kinds. A folder that was empty is not remembered: "nothing here" is a
 * statement, and it is only made by a read.
 */
interface RememberedFolder {
  rows: TeamMaterialRow[];
  total: number | null;
  next: FolderPageCursor | null;
  hidden: number;
  pages: number;
}
const REMEMBERED_FOLDERS = 24;
const remembered = new WeakMap<object, Map<string, RememberedFolder>>();

function recall(client: object, scopeKey: string): RememberedFolder | null {
  return remembered.get(client)?.get(scopeKey) ?? null;
}

function remember(client: object, scopeKey: string, folder: RememberedFolder | null) {
  let folders = remembered.get(client);
  if (!folders) {
    if (!folder) return;
    folders = new Map();
    remembered.set(client, folders);
  }
  // Re-inserted, so the map's order is the order of use and the first key is the oldest.
  folders.delete(scopeKey);
  if (!folder) return;
  folders.set(scopeKey, folder);
  if (folders.size > REMEMBERED_FOLDERS) folders.delete(folders.keys().next().value as string);
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
  /* Which folder the failure belongs to (070, FR-009). The error was shown only for a folder
     whose rows had once arrived, so a folder whose very first read failed sat on its skeleton
     for good — no message, no way to try again. */
  const [errorScope, setErrorScope] = useState<string | null>(null);
  const generation = useRef(0);
  const latestRefresh = useRef<Promise<ReadResult> | null>(null);
  const loadedPages = useRef(1);
  const appendRead = useRef<Promise<void> | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const beforeRowsReplaceRef = useRef(beforeRowsReplace);
  beforeRowsReplaceRef.current = beforeRowsReplace;

  /** How many rows the filter has taken out of the count so far. */
  const hiddenSoFar = useRef(0);
  /** The rows on show are remembered ones, not yet confirmed by a read of this visit. */
  const fromMemory = useRef(false);

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
        if (token === generation.current) {
          setError(true);
          setErrorScope(scopeKey);
        }
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
                rowsRef.current.length > 0 &&
                // Remembered rows are not this visit's: an empty answer replaces them.
                !fromMemory.current
              )) {
                hiddenSoFar.current = hidden;
                loadedPages.current = pagesRead;
                beforeRowsReplaceRef.current?.();
                setRows(visible);
                setTotal(Math.max(0, totalRows - hidden));
                setNext(cursor);
              }
              fromMemory.current = false;
              setDataScope(scopeKey);
              setError(false);
              read.succeed();
              return 'ok';
            } catch {
              if (token !== generation.current) return 'superseded';
              if (attempt === 1) {
                read.fail();
                setError(true);
                setErrorScope(scopeKey);
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

  const refreshRef = useRef(performRefresh);
  refreshRef.current = performRefresh;
  const coordinator = useRef<ReturnType<typeof createReadCoordinator<void>> | null>(null);
  const refreshWindow = useCallback(
    async (strict = false) => {
      if (activeScope.current !== scopeKey) {
        if (strict) throw new Error('CATALOG_REFRESH_SUPERSEDED');
        return;
      }
      const owner = coordinator.current;
      await appendRead.current;
      if (owner !== coordinator.current) {
        if (strict) throw new Error('CATALOG_REFRESH_SUPERSEDED');
        return;
      }
      try {
        await (strict ? owner?.requestFresh() : owner?.request());
        if (strict && owner !== coordinator.current) throw new Error('CATALOG_REFRESH_SUPERSEDED');
      } catch (cause) {
        // A background caller can share a strict owner's read. Only the caller
        // waiting for confirmation should reject; automatic invalidations have
        // no rejection handler and already expose failure through hook state.
        if (strict) throw cause;
      }
    },
    [scopeKey]
  );

  useEffect(() => {
    const owner: ReturnType<typeof createReadCoordinator<void>> = createReadCoordinator(
      async () => {
        try {
          await refreshRef.current(owner.hasFreshRequests());
        } catch (cause) {
          if (
            owner === coordinator.current &&
            cause instanceof Error &&
            cause.message === 'CATALOG_REFRESH_SUPERSEDED'
          )
            owner.deferFresh();
          else throw cause;
        }
      }
    );
    coordinator.current = owner;
    // A folder read before is shown as it was while this read brings it up to date.
    const seen = recall(client, scopeKey);
    setRows(seen?.rows ?? []);
    setTotal(seen?.total ?? null);
    setNext(seen?.next ?? null);
    loadedPages.current = seen?.pages ?? 1;
    fromMemory.current = Boolean(seen);
    if (seen) {
      hiddenSoFar.current = seen.hidden;
      setDataScope(scopeKey);
      setError(false);
    }
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
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [performRefresh, refreshWindow, client, scopeKey]);

  // What a completed read shows is what the folder is remembered as.
  useEffect(() => {
    if (dataScope !== scopeKey || loading || error) return;
    remember(
      client,
      scopeKey,
      rows.length > 0
        ? { rows, total, next, hidden: hiddenSoFar.current, pages: loadedPages.current }
        : null
    );
  }, [client, scopeKey, dataScope, loading, error, rows, total, next]);

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

  // The render before the effect above has run: a folder seen before is already there.
  const seen = dataScope === scopeKey ? null : recall(client, scopeKey);
  const failedHere = error && errorScope === scopeKey;
  return {
    rows: dataScope === scopeKey ? rows : (seen?.rows ?? EMPTY_ROWS),
    total: dataScope === scopeKey ? total : (seen?.total ?? null),
    loading: loading || (dataScope !== scopeKey && !seen && !failedHere),
    error: failedHere,
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
