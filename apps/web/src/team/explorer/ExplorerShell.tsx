import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  CatalogMaterialItem,
  TeamAnalyticsStorage,
  TeamMaterialRow,
  TeamPermissions
} from '@video-compressor/shared';
import { teamApi, type TeamMaterialSummary } from '../../api/team';
import { downloadTeamFileWithAgent } from '../../api/client';
import { Button, ProgressBar } from '../../components/ui';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { useOptionalAgent } from '../../AgentContext';
import { teamErrorMessageFor } from '../errors';
import { TeamCatalog, type TeamCatalogClient } from '../catalog/TeamCatalog';
import { TrashView } from '../catalog/TrashView';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import {
  defaultMaterialActionsClient,
  uploadTeamFile,
  type MaterialActionsClient
} from '../catalog/material-actions-client';
import type { TeamRouteQuery, ExplorerView } from '../routes';
import { Breadcrumb } from './Breadcrumb';
import { ContentGrid, type ContentGridClient } from './ContentGrid';
import { ContentList } from './ContentList';
import { ExplorerProvider, useExplorer, type ExplorerClient } from './ExplorerProvider';
import { FolderTree } from './FolderTree';
import { KindFilterMenu } from './KindFilterMenu';
import { SortMenu } from './SortMenu';
import { sortRows, readRememberedSort, rememberSort, type ExplorerSort } from './sort';
import { PreviewPane } from './PreviewPane';
import { Modal } from '../../components/Modal';
import { MaterialProcessFlow } from '../processing/MaterialProcessFlow';
import { useTeamOperation } from '../processing/useTeamOperation';
import { startTeamAgentProcess } from '../../api/client';
import { FolderProcessDialog, type FolderBatchPlan } from './FolderProcessDialog';
import {
  TeamCompressorDialog,
  type CompressPlan,
  type CompressPlanItem as CompressPlanItem_
} from './TeamCompressorDialog';
import type { RowActionsProps } from './RowActions';
import { useFolderPage } from './useFolderPage';

export type ExplorerShellClient = ExplorerClient &
  ContentGridClient &
  TeamCatalogClient &
  FolderPickerClient & {
    getConnectionStatus?: (teamId: string) => Promise<{ driveKind?: TeamAnalyticsStorage | null }>;
  };

export type { ExplorerView };

/**
 * The explorer (011, US3): one screen for everything the old Files, Landings
 * and Creatives tabs did. Tree on the left, the open folder (or a search, or
 * the trash) in the middle, the selected row on the right. Every piece of view
 * state lives in the address, so a refresh and a pasted link land on the same
 * screen.
 */
export function ExplorerShell({
  teamId,
  client,
  revision = 0,
  query,
  onQueryChange,
  onFolderChange,
  onSearched,
  onPreview,
  onCreateTask,
  onCreateTaskFromSelection,
  onProcessSelection,
  onChanged,
  onReset,
  actionsClient = defaultMaterialActionsClient,
  readOnly = false
}: {
  teamId: string;
  client: ExplorerShellClient;
  revision?: number;
  query: TeamRouteQuery;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
  onFolderChange: (folderId: string | null) => void;
  onSearched: (state: { query: string; filters: TeamRouteQuery['filters'] }) => void;
  onPreview?: (material: TeamMaterialSummary) => void;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  onCreateTaskFromSelection?: (assets: Array<{ id: string; name: string }>) => void;
  onProcessSelection?: () => void;
  onChanged?: () => void;
  onReset?: () => void;
  actionsClient?: MaterialActionsClient;
  /** Storage needs a person (011, FR-033): browse and preview only. */
  readOnly?: boolean;
}) {
  return (
    <ExplorerProvider
      teamId={teamId}
      client={client}
      revision={revision}
      folderId={query.folderId}
      onFolderChange={onFolderChange}
    >
      <ExplorerBody
        teamId={teamId}
        client={client}
        revision={revision}
        query={query}
        onQueryChange={onQueryChange}
        onSearched={onSearched}
        onPreview={onPreview}
        onCreateTask={onCreateTask}
        onCreateTaskFromSelection={onCreateTaskFromSelection}
        onProcessSelection={onProcessSelection}
        onChanged={onChanged}
        onReset={onReset}
        actionsClient={actionsClient}
        readOnly={readOnly}
      />
    </ExplorerProvider>
  );
}

function ExplorerBody({
  teamId,
  client,
  revision,
  query,
  onQueryChange,
  onSearched,
  onPreview,
  onCreateTask,
  onCreateTaskFromSelection,
  onProcessSelection,
  onChanged,
  onReset,
  actionsClient,
  readOnly
}: {
  teamId: string;
  client: ExplorerShellClient;
  revision: number;
  query: TeamRouteQuery;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
  onSearched: (state: { query: string; filters: TeamRouteQuery['filters'] }) => void;
  onPreview?: (material: TeamMaterialSummary) => void;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  onCreateTaskFromSelection?: (assets: Array<{ id: string; name: string }>) => void;
  onProcessSelection?: () => void;
  onChanged?: () => void;
  onReset?: () => void;
  actionsClient: MaterialActionsClient;
  readOnly: boolean;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { permissions: loadedPermissions } = useTeam();
  // Every write goes dark while storage needs a person (FR-033); nothing is lost.
  const permissions = readOnly ? null : loadedPermissions;
  const explorer = useExplorer();
  const {
    currentFolderId,
    selectedId,
    select,
    selectedIds,
    selectedRows: selectedRowsMap,
    clearSelection,
    pathTo,
    nodeOf
  } = explorer;
  const [treeOpen, setTreeOpen] = useState(false);
  const [processing, setProcessing] = useState<{
    row: TeamMaterialRow;
    tool?: 'transcription';
  } | null>(null);
  // Live progress of a running transcription, so the selected video's card can
  // show it in place of the Transcribe button (no re-clicking, and it is clear
  // which video is being transcribed).
  const [transcribing, setTranscribing] = useState<{ videoId: string; progress: number } | null>(
    null
  );
  // One transcription queue for the whole explorer (owner, 2026-08-30): the
  // card's Transcribe enqueues, the folder batch enqueues, and everything runs
  // in the background one after another — a corner panel shows the progress,
  // nothing blocks the screen.
  const agentCtx = useOptionalAgent();
  type QueueItem = {
    id: string;
    name: string;
    folderId: string | null;
    tool: 'transcription' | 'compressor';
    outputName: string;
    /** Overwrite-the-original: upload as a new version of this material. */
    versionOf?: string;
    /** 013 (B5): compress on the agent and save to a locally chosen folder. */
    local?: { embed: boolean; suffix: string };
    options?: Record<string, unknown>;
  };
  const [tQueue, setTQueue] = useState<QueueItem[]>([]);
  const [tActive, setTActive] = useState<(QueueItem & { operationId: string | null }) | null>(
    null
  );
  const [tDone, setTDone] = useState(0);
  const [tTotal, setTTotal] = useState(0);
  // Cmd/Ctrl+C/X/V: what was copied or cut, held until the next paste. Files
  // from any folder — paste lands them in the folder currently open.
  const clipboard = useRef<{
    mode: 'copy' | 'cut';
    items: { id: string; name: string; kind: string }[];
  } | null>(null);
  const [folderProcessing, setFolderProcessing] = useState<TeamMaterialRow | null>(null);
  const [compressing, setCompressing] = useState<CompressPlanItem_[] | null>(null);
  const [dropping, setDropping] = useState(false);
  const [storageKind, setStorageKind] = useState<TeamAnalyticsStorage | null>(null);
  const [companionDelete, setCompanionDelete] = useState<{
    companionId: string;
    dontAsk: boolean;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const view: ExplorerView = query.view ?? readRememberedView();
  const [sort, setSortState] = useState<ExplorerSort>(() => readRememberedSort());
  const setSort = (next: ExplorerSort) => {
    rememberSort(next);
    setSortState(next);
  };
  const searching = query.q.length > 0 || query.scope === 'space';
  const page = useFolderPage({
    teamId,
    client,
    parentFolderId: currentFolderId,
    kinds: query.kinds,
    revision
  });
  const sortedRows = useMemo(() => sortRows(page.rows, sort), [page.rows, sort]);

  useEffect(() => {
    let active = true;
    if (!client.getConnectionStatus) return;
    void client
      .getConnectionStatus(teamId)
      .then(status => {
        if (active) setStorageKind(status.driveKind ?? null);
      })
      .catch(() => {
        if (active) setStorageKind(null);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);

  const changed = useCallback(() => {
    onChanged?.();
    void page.reload();
  }, [onChanged, page]);

  const trashCompanion = useCallback(
    async (companionId: string) => {
      try {
        await actionsClient.trashMaterial({
          teamId,
          materialId: companionId,
          idempotencyKey: crypto.randomUUID()
        });
      } catch (cause) {
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      }
      changed();
    },
    [actionsClient, changed, push, t, teamId]
  );

  // A trashed video's transcript companion follows it: silently by the account
  // setting, or after one question. Here, not in the row, so the dialog
  // survives the row leaving the list (012, T012).
  const onVideoTrashed = useCallback(
    async (videoId: string) => {
      const companion = await teamApi.getTranscriptCompanion(teamId, videoId).catch(() => null);
      if (!companion) return;
      const pref = await teamApi.getTranscriptDeletePref().catch(() => 'ask' as const);
      if (pref === 'keep') return;
      if (pref === 'delete') {
        await trashCompanion(companion.id);
        return;
      }
      setCompanionDelete({ companionId: companion.id, dontAsk: false });
    },
    [teamId, trashCompanion]
  );

  const setView = (next: ExplorerView) => {
    rememberView(next);
    onQueryChange({ view: next });
  };

  /** Root-relative path for a search result, from the cached tree. */
  const pathFor = useCallback(
    (item: CatalogMaterialItem) => {
      const parent = item.parentFolderId ?? null;
      if (!parent || !nodeOf(parent)) return t('teamExplorerRootLabel');
      return [t('teamExplorerRootLabel'), ...pathTo(parent).map(node => node.name)].join(' / ');
    },
    [nodeOf, pathTo, t]
  );

  /** A drag onto a folder in the tree: move, and offer the way back (FR-026). */
  const moveTo = useCallback(
    async (folderDriveId: string, materialIds: string[]) => {
      if (!permissions?.edit) return;
      const previous = currentFolderId ?? null;
      for (const materialId of materialIds) {
        try {
          await actionsClient.moveMaterial({
            teamId,
            materialId,
            destinationFolderId: folderDriveId,
            conflictMode: 'keep_both',
            idempotencyKey: crypto.randomUUID()
          });
        } catch (cause) {
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          changed();
          return;
        }
      }
      changed();
      clearSelection();
      const target = nodeOf(folderDriveId)?.name ?? t('teamExplorerRootLabel');
      push({
        tone: 'success',
        text: `${t('teamToastMoved')} → ${target}`,
        ...(previous !== null
          ? {
              action: {
                label: t('teamExplorerMovedUndo'),
                run: () => void moveTo(previous, materialIds)
              }
            }
          : {})
      });
    },
    [
      actionsClient,
      changed,
      clearSelection,
      currentFolderId,
      nodeOf,
      permissions?.edit,
      push,
      t,
      teamId
    ]
  );

  /** Files dropped on the content area, or picked from the "Add files" input. */
  const upload = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0 || !permissions?.upload) return;
      // No folder open means the space root, which the server resolves from the
      // connection. Inferring it from the first top-level folder refused every
      // upload into an empty space — with a message about Drive being
      // unavailable, which it was not.
      const destination = currentFolderId;
      let done = 0;
      for (const file of list) {
        try {
          await uploadTeamFile({
            teamId,
            destinationFolderId: destination,
            file,
            conflictMode: 'keep_both',
            replaceMaterialId: null,
            versionOfMaterialId: null
          });
          done += 1;
        } catch (cause) {
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        }
      }
      if (done > 0) push({ tone: 'success', text: t('teamExplorerUploadDone', { count: done }) });
      changed();
    },
    [changed, currentFolderId, explorer, permissions?.upload, push, t, teamId]
  );

  const actions: RowActionsProps | undefined = permissions
    ? {
        teamId,
        permissions,
        browseClient: client,
        actionsClient,
        storageKind,
        onChanged: changed,
        onVideoTrashed: (videoId: string) => void onVideoTrashed(videoId),
        ...(permissions.process
          ? {
              onProcess: (row: TeamMaterialRow) => setProcessing({ row }),
              onProcessFolder: (row: TeamMaterialRow) => setFolderProcessing(row)
            }
          : {})
      }
    : undefined;

  // The batch spans folders, so it comes from the accumulated selection map
  // rather than only the rows on the current page.
  const selectedRows = useMemo(() => Array.from(selectedRowsMap.values()), [selectedRowsMap]);
  const focused = page.rows.find(row => row.id === selectedId) ?? null;

  /** Rows going to the trash from the keyboard or the selection bar, with the way back. */
  const trashRows = useCallback(
    async (rows: TeamMaterialRow[]) => {
      if (!permissions?.delete) return;
      const trashed: string[] = [];
      for (const row of rows) {
        if (row.kind === 'folder') continue;
        try {
          await actionsClient.trashMaterial({
            teamId,
            materialId: row.id,
            idempotencyKey: crypto.randomUUID()
          });
          trashed.push(row.id);
        } catch (cause) {
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          break;
        }
      }
      if (trashed.length === 0) return;
      select(null);
      clearSelection();
      changed();
      const restore = async () => {
        for (const materialId of trashed) {
          try {
            await actionsClient.restoreMaterial({
              teamId,
              materialId,
              idempotencyKey: crypto.randomUUID()
            });
          } catch (cause) {
            push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
            break;
          }
        }
        changed();
        push({ tone: 'success', text: t('teamToastRestored') });
      };
      push({
        tone: 'success',
        text:
          trashed.length === 1
            ? t('teamToastTrashed')
            : t('teamExplorerTrashedCount', { count: trashed.length }),
        action: { label: t('teamUndo'), run: () => void restore() }
      });
    },
    [actionsClient, changed, clearSelection, permissions?.delete, push, select, t, teamId]
  );

  /**
   * Keyboard on the content area (FR-027): arrows move, Enter opens, Escape
   * clears, Delete trashes with undo. Keys typed into a field — the rename
   * form inside a row menu, most of all — are that field's; letting them
   * through here opened a preview on Enter and toggled the selection on every
   * space in the new name.
   */
  const enqueueJobs = (items: QueueItem[]) => {
    const known = new Set(
      [...tQueue, ...(tActive ? [tActive] : [])].map(item => `${item.tool}:${item.id}`)
    );
    const fresh = items.filter(item => !known.has(`${item.tool}:${item.id}`));
    if (fresh.length === 0) return;
    setTQueue(current => [...current, ...fresh]);
    setTTotal(current => current + fresh.length);
    if (tActive || tQueue.length > 0) {
      push({ tone: 'success', text: t('teamTranscribeQueueAdded', { count: fresh.length }) });
    }
  };

  const enqueueTranscriptions = (items: { id: string; name: string; folderId: string | null }[]) =>
    enqueueJobs(
      items.map(item => ({
        ...item,
        tool: 'transcription' as const,
        outputName: `${item.name.replace(/\.[^.]+$/u, '')}.txt`
      }))
    );

  // Takes the next queued video whenever nothing is running.
  useEffect(() => {
    if (tActive || tQueue.length === 0) return;
    const next = tQueue[0];
    setTActive({ ...next, operationId: null });
    void (async () => {
      try {
        if (next.local) {
          // 013 (B5): no team operation — the agent downloads the source,
          // compresses it locally and saves into a natively chosen folder.
          const grant = await teamApi.requestDownload(teamId, next.id, 'agent');
          if (grant.kind !== 'agent') throw new Error('AGENT_UPDATE_REQUIRED');
          const saved = await downloadTeamFileWithAgent({
            transferUrl: grant.transferUrl,
            transferGrant: grant.grant,
            fileName: next.name,
            compress: next.local
          });
          push({ tone: 'success', text: t('teamCompressLocalSaved', { name: saved.fileName }) });
          return;
        }
        const result = await teamApi.startProcess({
          teamId,
          materialId: next.id,
          toolId: next.tool,
          optionsSummary: next.options ?? {},
          // The server's optionalDestination treats null as the space root; the
          // client type predates that and still says string.
          destinationFolderId: (next.folderId ?? null) as unknown as string,
          outputName: next.outputName,
          ...(next.versionOf ? { versionOfMaterialId: next.versionOf } : {}),
          conflictMode: 'keep_both',
          idempotencyKey: crypto.randomUUID(),
          agentContractVersion: 1,
          toolContractVersion: agentCtx?.toolContracts?.[next.tool] ?? 0
        });
        setTActive(current =>
          current && current.id === next.id
            ? { ...current, operationId: result.operationId }
            : current
        );
        await startTeamAgentProcess({
          operationId: result.operationId,
          toolId: next.tool,
          options: next.options ?? {},
          sourceGrant: result.sourceGrant,
          finalizeGrant: result.finalizeGrant
        });
      } catch (cause) {
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      } finally {
        setTDone(current => current + 1);
        setTActive(null);
        setTQueue(current => current.slice(1));
        changed();
      }
    })();
  }, [agentCtx?.toolContracts, changed, push, t, tActive, tQueue, teamId]);

  // The queue drained: one closing toast, counters reset.
  useEffect(() => {
    if (tActive || tQueue.length > 0 || tTotal === 0) return;
    push({ tone: 'success', text: t('teamTranscribeQueueDone', { count: tDone }) });
    setTDone(0);
    setTTotal(0);
  }, [push, t, tActive, tDone, tQueue.length, tTotal]);

  const activeOperation = useTeamOperation({
    teamId,
    operationId: tActive?.operationId ?? null
  });
  const activeProgress = Math.max(
    activeOperation.operation?.progress ?? 0,
    activeOperation.localProgress?.progress ?? 0
  );

  const runCompressPlan = (plan: CompressPlan) => {
    const suffix = plan.suffix;
    const jobs: QueueItem[] = plan.items.map(item => {
      const stem = item.name.replace(/\.[^.]+$/u, '');
      const overwrite = plan.destination.kind === 'overwrite';
      const outputName = overwrite
        ? suffix
          ? `${stem}${suffix}.mp4`
          : item.name
        : `${stem}${suffix || '_1'}.mp4`;
      return {
        id: item.id,
        name: item.name,
        folderId: plan.destination.kind === 'folder' ? plan.destination.folderId : item.folderId,
        tool: 'compressor' as const,
        outputName,
        ...(overwrite ? { versionOf: item.id } : {}),
        ...(plan.destination.kind === 'local'
          ? { local: { embed: plan.embed, suffix } }
          : {}),
        options: plan.embed ? { imageEmbedding: { enabled: true } } : {}
      };
    });
    enqueueJobs(jobs);
  };

  const runFolderBatch = (plan: FolderBatchPlan) => {
    if (plan.what !== 'landings' && plan.videos.length > 0) {
      enqueueTranscriptions(
        plan.videos.map(video => ({
          id: video.id,
          name: video.name,
          // Beside the video itself, not in the folder the batch started from:
          // the batch reaches into subfolders, and a hundred transcripts piled
          // at the top would be worse than no transcripts at all.
          folderId: video.parentFolderId ?? plan.folder.driveFileId
        }))
      );
    }
    if (plan.what !== 'videos' && plan.landings.length > 0) {
      const landings = plan.landings;
      push({ tone: 'success', text: t('teamFolderProcessLandingsQueued', { count: landings.length }) });
      void (async () => {
        for (const landing of landings) {
          await teamApi.regenerateLandingPreview(teamId, landing.id).catch(() => undefined);
        }
        changed();
      })();
    }
  };

  const pasteClipboard = async () => {
    const clip = clipboard.current;
    if (!clip) return;
    if (clip.mode === 'copy' && !permissions?.upload) return;
    if (clip.mode === 'cut' && !permissions?.edit) return;
    // The Drive API cannot copy folders; a cut (move) handles them fine.
    const items = clip.mode === 'copy' ? clip.items.filter(item => item.kind !== 'folder') : clip.items;
    const skipped = clip.items.length - items.length;
    if (items.length === 0) {
      push({ tone: 'error', text: t('teamExplorerPasteFoldersOnly') });
      return;
    }
    let done = 0;
    for (const item of items) {
      try {
        if (clip.mode === 'copy') {
          await teamApi.copyMaterial({
            teamId,
            materialId: item.id,
            destinationFolderId: currentFolderId ?? null,
            idempotencyKey: crypto.randomUUID()
          });
        } else {
          await actionsClient.moveMaterial({
            teamId,
            materialId: item.id,
            destinationFolderId: currentFolderId ?? null,
            conflictMode: 'keep_both',
            idempotencyKey: crypto.randomUUID()
          });
        }
        done += 1;
      } catch (cause) {
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        break;
      }
    }
    if (clip.mode === 'cut') clipboard.current = null;
    if (done > 0) {
      changed();
      clearSelection();
      push({ tone: 'success', text: t('teamExplorerPastedCount', { count: done }) });
      if (skipped > 0) {
        push({ tone: 'error', text: t('teamExplorerPasteFoldersSkipped', { count: skipped }) });
      }
    }
  };

  const onContentKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (sortedRows.length === 0) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (isEditableTarget(target) || target?.closest('.team-row-menu')) return;
    const index = sortedRows.findIndex(row => row.id === selectedId);
    const step = view === 'grid' ? gridColumns(event.currentTarget) : 1;
    let next: TeamMaterialRow | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = sortedRows[Math.min(sortedRows.length - 1, index < 0 ? 0 : index + step)];
        break;
      case 'ArrowUp':
        next = sortedRows[Math.max(0, index - step)];
        break;
      case 'ArrowRight':
        if (view !== 'grid') return;
        next = sortedRows[Math.min(sortedRows.length - 1, index + 1)];
        break;
      case 'ArrowLeft':
        if (view !== 'grid') return;
        next = sortedRows[Math.max(0, index - 1)];
        break;
      case 'Enter':
        if (!focused) return;
        if (focused.kind === 'folder') explorer.openFolder(focused.driveFileId);
        else onPreview?.(summaryOf(focused));
        break;
      case 'Escape':
        select(null);
        clearSelection();
        break;
      case ' ':
        if (focused) explorer.toggleSelected(focused);
        break;
      case 'Delete':
      case 'Backspace': {
        const rows = selectedRows.length > 0 ? selectedRows : focused ? [focused] : [];
        if (rows.length === 0 || !permissions?.delete) return;
        void trashRows(rows);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    if (next) select(next.id);
  };

  const trash = query.trash;

  // `/` opens the search from anywhere on the folder screen (FR-027). The
  // search bar binds the same key once it is mounted; before that there was
  // nothing listening, so the shortcut only worked when it was not needed.
  useEffect(() => {
    if (searching || trash) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target instanceof HTMLElement ? event.target : null)) return;
      event.preventDefault();
      onQueryChange({ scope: 'space' });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onQueryChange, searching, trash]);

  // Cmd/Ctrl+C copies, +X cuts, +V pastes into the open folder — from anywhere
  // on the folder screen, because focus rarely sits inside the list. The batch
  // is the toggled selection (even from other folders), or the focused row.
  useEffect(() => {
    if (searching || trash || readOnly) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (isEditableTarget(event.target instanceof HTMLElement ? event.target : null)) return;
      const key = event.key.toLowerCase();
      if (key === 'c' || key === 'x') {
        const rows = selectedRows.length > 0 ? selectedRows : focused ? [focused] : [];
        if (rows.length === 0) return;
        clipboard.current = {
          mode: key === 'c' ? 'copy' : 'cut',
          items: rows.map(row => ({ id: row.id, name: row.name, kind: row.kind }))
        };
        push({
          tone: 'success',
          text: t(key === 'c' ? 'teamExplorerCopiedCount' : 'teamExplorerCutCount', {
            count: rows.length
          })
        });
        event.preventDefault();
        return;
      }
      if (key === 'v' && clipboard.current) {
        event.preventDefault();
        void pasteClipboard();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div className={`team-explorer has-pane${treeOpen ? ' is-tree-open' : ''}`}>
      <FolderTree onDropMaterials={(folder, ids) => void moveTo(folder, ids)} onReset={onReset} />
      <div className="team-explorer-toolbar">
        <Button
          type="button"
          variant="ghost"
          className="team-explorer-folders-toggle"
          aria-pressed={treeOpen}
          onClick={() => setTreeOpen(open => !open)}
        >
          {t('teamExplorerFoldersToggle')}
        </Button>
        {trash ? (
          <Button type="button" variant="ghost" onClick={() => onQueryChange({ trash: false })}>
            ← {t('teamExplorerBackToFiles')}
          </Button>
        ) : (
          <Breadcrumb />
        )}
        <div className="team-explorer-toolbar-actions">
          {!trash && (
            <Button
              type="button"
              variant="secondary"
              aria-pressed={searching}
              onClick={() =>
                searching
                  ? onQueryChange({ q: '', scope: 'folder', filters: undefined })
                  : onQueryChange({ scope: 'space' })
              }
            >
              {searching ? t('teamExplorerSearchClose') : t('teamExplorerSearchOpen')}
            </Button>
          )}
          {permissions?.upload && !trash && (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={event => {
                  if (event.target.files) void upload(event.target.files);
                  event.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => fileInput.current?.click()}
              >
                {t('teamExplorerAddFiles')}
              </Button>
            </>
          )}
          {!trash && (
            <div
              className="team-explorer-view-toggle"
              role="group"
              aria-label={t('teamExplorerViewLabel')}
            >
              <button
                type="button"
                aria-pressed={view === 'list'}
                aria-label={t('teamExplorerViewList')}
                title={t('teamExplorerViewList')}
                onClick={() => setView('list')}
              >
                <ListViewIcon />
              </button>
              <button
                type="button"
                aria-pressed={view === 'grid'}
                aria-label={t('teamExplorerViewGrid')}
                title={t('teamExplorerViewGrid')}
                onClick={() => setView('grid')}
              >
                <GridViewIcon />
              </button>
            </div>
          )}
        </div>
      </div>
      <div
        className={`team-explorer-main team-explorer-dropzone${dropping ? ' is-over' : ''}`}
        onDragOver={event => {
          if (!permissions?.upload || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={event => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDropping(false);
          void upload(event.dataTransfer.files);
        }}
      >
        {readOnly && (
          <p className="team-explorer-readonly" role="status">
            {t('teamStorageReadOnly')}
          </p>
        )}
        {!trash && !searching && (
          <div className="team-explorer-list-controls">
            <KindFilterMenu kinds={query.kinds} onChange={kinds => onQueryChange({ kinds })} />
            <SortMenu sort={sort} onChange={setSort} />
          </div>
        )}
        {selectedRows.length > 0 && !trash && (
          <div
            className="team-explorer-selection-bar"
            role="region"
            aria-label={t('teamExplorerSelectedCount', { count: selectedRows.length })}
          >
            <span>{t('teamExplorerSelectedCount', { count: selectedRows.length })}</span>
            {onCreateTaskFromSelection && (
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  onCreateTaskFromSelection(
                    selectedRows.map(row => ({ id: row.id, name: row.name }))
                  )
                }
              >
                {t('teamExplorerCreateTaskFromSelection')}
              </Button>
            )}
            {onProcessSelection && permissions?.process && (
              <Button type="button" variant="secondary" onClick={onProcessSelection}>
                {t('teamExplorerProcessSelection')}
              </Button>
            )}
            {permissions?.process && selectedRows.some(row => row.category === 'video') && (
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  setCompressing(
                    selectedRows
                      .filter(row => row.category === 'video')
                      .map(row => ({
                        id: row.id,
                        name: row.name,
                        folderId: row.parentFolderId ?? currentFolderId ?? null
                      }))
                  )
                }
              >
                {t('teamCompressSelected')}
              </Button>
            )}
            {permissions?.delete && (
              <Button type="button" variant="danger" onClick={() => void trashRows(selectedRows)}>
                {t('teamFileTrash')}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={clearSelection}>
              {t('teamExplorerClearSelection')}
            </Button>
          </div>
        )}
        {trash ? (
          <TrashView key={`trash:${teamId}`} teamId={teamId} />
        ) : searching ? (
          <TeamCatalog
            key={`search:${teamId}`}
            teamId={teamId}
            client={client}
            onCreateTask={onCreateTask}
            initialQuery={query.q}
            initialFilters={query.filters}
            onSearched={onSearched}
            autoFocusSearch
            scopeFolderId={currentFolderId}
            scope={query.scope}
            onScopeChange={scope => onQueryChange({ scope })}
            kinds={query.kinds}
            pathFor={pathFor}
          />
        ) : (
          <div
            className="team-explorer-content-keys"
            tabIndex={0}
            role="presentation"
            data-rows={page.rows.length}
            data-selected={selectedId ?? ''}
            onKeyDown={onContentKeyDown}
          >
            {view === 'grid' ? (
              <ContentGrid
                client={client}
                revision={revision}
                kinds={query.kinds}
                onPreview={onPreview}
                actions={actions}
                sort={sort}
              />
            ) : (
              <ContentList
                client={client}
                revision={revision}
                kinds={query.kinds}
                onPreview={onPreview}
                actions={actions}
                sort={sort}
              />
            )}
          </div>
        )}
        {dropping && <p className="team-explorer-muted">{t('teamExplorerDropHint')}</p>}
      </div>
      <PreviewPane
        row={trash || searching ? null : focused}
        client={client}
        onOpen={onPreview}
        onTranscribe={
          permissions?.process
            ? row =>
                enqueueTranscriptions([
                  {
                    id: row.id,
                    name: row.name,
                    folderId: row.parentFolderId ?? currentFolderId ?? null
                  }
                ])
            : undefined
        }
        transcribing={
          tActive
            ? { videoId: tActive.id, progress: activeProgress }
            : transcribing
        }
        onCreateTask={onCreateTask}
      />
      {companionDelete && (
        <Modal
          labelledBy="team-companion-delete-title"
          onClose={() => setCompanionDelete(null)}
          className="team-companion-delete"
        >
          <h3 id="team-companion-delete-title">{t('teamTranscriptDeleteTitle')}</h3>
          <p>{t('teamTranscriptDeleteBody')}</p>
          <label className="team-companion-delete-remember">
            <input
              type="checkbox"
              checked={companionDelete.dontAsk}
              onChange={event =>
                setCompanionDelete(current =>
                  current ? { ...current, dontAsk: event.target.checked } : current
                )
              }
            />
            {t('teamTranscriptDeleteRemember')}
          </label>
          <div className="team-dialog-actions">
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                const { companionId, dontAsk } = companionDelete;
                setCompanionDelete(null);
                if (dontAsk) void teamApi.setTranscriptDeletePref('delete').catch(() => undefined);
                void trashCompanion(companionId);
              }}
            >
              {t('teamTranscriptDeleteYes')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                const { dontAsk } = companionDelete;
                setCompanionDelete(null);
                if (dontAsk) void teamApi.setTranscriptDeletePref('keep').catch(() => undefined);
              }}
            >
              {t('teamTranscriptDeleteNo')}
            </Button>
          </div>
        </Modal>
      )}
      {compressing && (
        <TeamCompressorDialog
          teamId={teamId}
          items={compressing}
          client={client}
          onRun={runCompressPlan}
          onClose={() => setCompressing(null)}
        />
      )}
      {folderProcessing && (
        <FolderProcessDialog
          teamId={teamId}
          folder={folderProcessing}
          client={client}
          onRun={runFolderBatch}
          onCompressAll={videos => {
            const folderId = folderProcessing.driveFileId;
            setFolderProcessing(null);
            setCompressing(videos.map(video => ({ id: video.id, name: video.name, folderId })));
          }}
          onClose={() => setFolderProcessing(null)}
        />
      )}
      {(tActive || tQueue.length > 0) && (
        <aside className="team-transcribe-queue" aria-live="polite">
          <strong>
            {t(tActive?.tool === 'compressor' ? 'teamCompressQueueTitle' : 'teamTranscribeQueueTitle')}
          </strong>
          {tActive && (
            <p>
              {t('teamTranscribeQueueProgress', {
                done: tDone + 1,
                total: tTotal,
                name: tActive.name
              })}
            </p>
          )}
          <ProgressBar value={activeProgress} active label={t('teamTranscribeQueueTitle')} />
          {tQueue.length > (tActive ? 0 : 1) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setTQueue(tActive ? [] : current => current.slice(0, 1));
                setTTotal(tDone + (tActive ? 1 : 1));
              }}
            >
              {t('teamTranscribeQueueStop')}
            </Button>
          )}
        </aside>
      )}
      {processing && (
        <MaterialProcessFlow
          teamId={teamId}
          material={{
            id: processing.row.id,
            name: processing.row.name,
            category: processing.row.category
          }}
          initialTool={processing.tool}
          destinationFolderId={processing.row.parentFolderId ?? currentFolderId ?? null}
          browseClient={client}
          onProgress={
            processing.tool === 'transcription'
              ? ({ progress, state }) =>
                  setTranscribing(
                    state === 'pending' || state === 'running'
                      ? { videoId: processing.row.id, progress }
                      : null
                  )
              : undefined
          }
          onClose={() => {
            setProcessing(null);
            setTranscribing(null);
            changed();
          }}
        />
      )}
    </div>
  );
}

const VIEW_KEY = 'soty.team.explorer.view';

/** Someone typing owns their keys; the explorer's shortcuts never apply there. */
function isEditableTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

function readRememberedView(): ExplorerView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function rememberView(view: ExplorerView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // A browser that refuses storage still gets the address.
  }
}

function ListViewIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M4 5h2v2H4zm4 .25h12v1.5H8zM4 11h2v2H4zm4 .25h12v1.5H8zM4 17h2v2H4zm4 .25h12v1.5H8z"
      />
    </svg>
  );
}

function GridViewIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z" />
    </svg>
  );
}

function gridColumns(element: HTMLElement): number {
  const grid = element.querySelector<HTMLElement>('.team-explorer-grid');
  if (!grid) return 1;
  const tiles = grid.querySelectorAll<HTMLElement>('.team-explorer-tile');
  if (tiles.length < 2) return 1;
  const firstTop = tiles[0]!.offsetTop;
  let columns = 1;
  for (let index = 1; index < tiles.length; index += 1) {
    if (tiles[index]!.offsetTop !== firstTop) break;
    columns += 1;
  }
  return Math.max(1, columns);
}

function summaryOf(row: TeamMaterialRow): TeamMaterialSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    providerId: row.driveFileId,
    parentFolderId: row.parentFolderId,
    name: row.name,
    kind: row.kind === 'folder' ? 'folder' : row.kind === 'shortcut' ? 'shortcut' : 'file',
    category: row.category,
    mimeType: row.mimeType,
    fileExtension: row.fileExtension,
    sizeBytes: row.sizeBytes,
    modifiedAt: row.modifiedAt,
    previewState: row.previewState
  };
}

// Keeps the unused-permissions typing honest for callers that pass a partial set.
export type ExplorerPermissions = TeamPermissions;
