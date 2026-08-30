import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type { TeamFolderNode, TeamMaterialRow } from '@video-compressor/shared';
import { trackTeamIndexCompleted } from '../../analytics/service';

/**
 * The explorer's shared state (011): the one-call folder tree, the open
 * folder, and the paths between them. The tree is read from the index, never
 * from the provider, so opening a folder costs nothing on the click path
 * (FR-009); it is re-read when the space's realtime revision moves.
 */
export interface ExplorerClient {
  listFolderTree: (teamId: string) => Promise<TeamFolderNode[]>;
}

export interface ExplorerContextValue {
  teamId: string;
  /** Null until the first read lands; empty when the space has no folders. */
  nodes: TeamFolderNode[] | null;
  loading: boolean;
  error: boolean;
  /** Drive ids of the folders that sit directly under the root (or a picked folder). */
  topLevelIds: string[];
  /** The open folder's drive id; null is the root. */
  currentFolderId: string | null;
  openFolder: (folderId: string | null) => void;
  childrenOf: (folderId: string | null) => TeamFolderNode[];
  nodeOf: (folderId: string) => TeamFolderNode | null;
  /** Root-to-folder path, excluding the root itself. */
  pathTo: (folderId: string | null) => TeamFolderNode[];
  refresh: () => Promise<void>;
  /** The focused row's material id; the preview pane follows it (011). */
  selectedId: string | null;
  select: (materialId: string | null) => void;
  /** Multi-selection for batch actions (011, US3). Accumulates across folders. */
  selectedIds: ReadonlySet<string>;
  /** The selected rows themselves, kept so a batch can span several folders. */
  selectedRows: ReadonlyMap<string, TeamMaterialRow>;
  toggleSelected: (row: TeamMaterialRow) => void;
  clearSelection: () => void;
}

const ExplorerContext = createContext<ExplorerContextValue | null>(null);

const REFRESH_DEBOUNCE_MS = 500;

export function ExplorerProvider({
  teamId,
  client,
  revision = 0,
  folderId = null,
  onFolderChange,
  children
}: {
  teamId: string;
  client: ExplorerClient;
  /** The space's realtime revision; a bump re-reads the tree (debounced). */
  revision?: number;
  /** The folder the address names. */
  folderId?: string | null;
  onFolderChange?: (folderId: string | null) => void;
  children: ReactNode;
}) {
  const [nodes, setNodes] = useState<TeamFolderNode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(folderId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<ReadonlyMap<string, TeamMaterialRow>>(
    () => new Map()
  );
  const selectedIds = useMemo<ReadonlySet<string>>(
    () => new Set(selectedRows.keys()),
    [selectedRows]
  );
  const activeRef = useRef(true);
  const indexingSince = useRef<number | null>(null);

  const read = useCallback(async () => {
    setLoading(true);
    try {
      const value = await client.listFolderTree(teamId);
      if (!activeRef.current) return;
      setNodes(value);
      setError(false);
      // FR-035: the moment every folder is listed, once per indexing run.
      const unindexed = value.filter(node => node.indexedAt === null).length;
      if (unindexed > 0 && indexingSince.current === null) indexingSince.current = Date.now();
      if (unindexed === 0 && indexingSince.current !== null) {
        trackTeamIndexCompleted({
          folderCount: value.length,
          fileCount: value.reduce((sum, node) => sum + node.childFileCount, 0),
          durationMs: Date.now() - indexingSince.current
        });
        indexingSince.current = null;
      }
    } catch {
      if (activeRef.current) setError(true);
    } finally {
      if (activeRef.current) setLoading(false);
    }
  }, [client, teamId]);

  useEffect(() => {
    activeRef.current = true;
    setNodes(null);
    void read();
    return () => {
      activeRef.current = false;
    };
  }, [read]);

  useEffect(() => {
    if (revision === 0) return;
    const timer = window.setTimeout(() => void read(), REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [read, revision]);

  useEffect(() => {
    setCurrentFolderId(folderId);
    setSelectedId(null);
    // The multi-selection is intentionally NOT cleared here: a batch can be
    // built up across folders — select a few, move on, select more.
  }, [folderId]);

  const byDriveId = useMemo(() => {
    const map = new Map<string, TeamFolderNode>();
    for (const node of nodes ?? []) map.set(node.driveFileId, node);
    return map;
  }, [nodes]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, TeamFolderNode[]>();
    for (const node of nodes ?? []) {
      // A parent that is not itself a folder row is the root or a picked folder.
      const key =
        node.parentFolderId && byDriveId.has(node.parentFolderId) ? node.parentFolderId : null;
      const list = map.get(key) ?? [];
      list.push(node);
      map.set(key, list);
    }
    return map;
  }, [byDriveId, nodes]);

  const topLevelIds = useMemo(
    () => (childrenByParent.get(null) ?? []).map(node => node.driveFileId),
    [childrenByParent]
  );

  const openFolder = useCallback(
    (next: string | null) => {
      setCurrentFolderId(next);
      onFolderChange?.(next);
    },
    [onFolderChange]
  );

  const pathTo = useCallback(
    (target: string | null) => {
      const path: TeamFolderNode[] = [];
      let cursor = target ? byDriveId.get(target) : undefined;
      let guard = 0;
      while (cursor && guard < 128) {
        path.unshift(cursor);
        cursor = cursor.parentFolderId ? byDriveId.get(cursor.parentFolderId) : undefined;
        guard += 1;
      }
      return path;
    },
    [byDriveId]
  );

  const value = useMemo<ExplorerContextValue>(
    () => ({
      teamId,
      nodes,
      loading,
      error,
      topLevelIds,
      currentFolderId,
      openFolder,
      childrenOf: parent =>
        childrenByParent.get(parent && byDriveId.has(parent) ? parent : null) ?? [],
      nodeOf: id => byDriveId.get(id) ?? null,
      pathTo,
      refresh: read,
      selectedId,
      select: setSelectedId,
      selectedIds,
      selectedRows,
      toggleSelected: (row: TeamMaterialRow) =>
        setSelectedRows(current => {
          const next = new Map(current);
          if (next.has(row.id)) next.delete(row.id);
          else next.set(row.id, row);
          return next;
        }),
      clearSelection: () => setSelectedRows(new Map())
    }),
    [
      byDriveId,
      childrenByParent,
      currentFolderId,
      error,
      loading,
      nodes,
      openFolder,
      pathTo,
      read,
      selectedId,
      selectedIds,
      selectedRows,
      teamId,
      topLevelIds
    ]
  );

  return <ExplorerContext.Provider value={value}>{children}</ExplorerContext.Provider>;
}

export function ExplorerContextOverride({
  value,
  children
}: {
  value: ExplorerContextValue;
  children: ReactNode;
}) {
  return <ExplorerContext.Provider value={value}>{children}</ExplorerContext.Provider>;
}

export function useExplorer(): ExplorerContextValue {
  const value = useContext(ExplorerContext);
  if (!value) throw new Error('useExplorer must be used within an ExplorerProvider');
  return value;
}
