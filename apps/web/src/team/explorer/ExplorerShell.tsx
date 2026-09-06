import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react';
import { usablePrep } from '@video-compressor/shared';
import type {
  CatalogMaterialItem,
  TeamAnalyticsStorage,
  TeamMaterialRow,
  TeamMaterialTagColor,
  TeamPermissions
} from '@video-compressor/shared';
import { teamApi, type TeamMaterialSummary } from '../../api/team';
import { downloadTeamFileWithAgent } from '../../api/client';
import { Download, ListPlus, Play, Shrink, Trash2, X } from 'lucide-react';
import { Button } from '../../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import {
  copyMaterialWithTail,
  moveMaterialWithTail,
  trashMaterialWithTail,
  type TailClient
} from '../materials/tail';
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
import { MaterialProcessFlow } from '../processing/MaterialProcessFlow';
import { useTeamOperation } from '../processing/useTeamOperation';
import {
  cancelTeamAgentProcess,
  pauseTeamAgentProcess,
  startTeamAgentProcess
} from '../../api/client';
import type { LibraryBatchScope } from '../library/ProcessLibraryDialog';
import {
  BATCH_SCOPE_LIMIT,
  FolderScopeDialog,
  scopeIdsOf,
  type FolderSubtreeClient,
  type ProcessableFolder
} from './FolderScopeDialog';
import {
  TeamCompressorDialog,
  type CompressPlan,
  type CompressPlanItem as CompressPlanItem_
} from './TeamCompressorDialog';
import type { RowActionsProps } from './RowActions';
import { useRestitchDelivery } from '../restitch/useRestitchDelivery';
import { RestitchDeliveryNotices } from '../restitch/RestitchDeliveryNotices';
import {
  UploadConflictDialog,
  type UploadConflictChoice,
  type UploadConflictRequest
} from './UploadConflictDialog';
import { ProcessPanel } from './ProcessPanel';
import { navigateTo } from '../../lib/navigation';
import { buildTeamRoute } from '../routes';
import { useFolderPage } from './useFolderPage';
import { usePosterFrames } from './usePosterFrames';

export type ExplorerShellClient = ExplorerClient &
  ContentGridClient &
  TeamCatalogClient &
  FolderPickerClient &
  FolderSubtreeClient & {
    getConnectionStatus?: (teamId: string) => Promise<{ driveKind?: TeamAnalyticsStorage | null }>;
    /** Only the space's owner may call this; the database is what enforces it. */
    setMaterialTag?: (input: {
      teamId: string;
      materialId: string;
      color: TeamMaterialTagColor | null;
    }) => Promise<TeamMaterialTagColor | null>;
  };

export type { ExplorerView };

/**
 * The explorer (011, US3): one screen for everything the old Files, Landings
 * and Creatives tabs did. Tree on the left, the open folder (or a search, or
 * the trash) in the middle, the selected row on the right. Every piece of view
 * state lives in the address, so a refresh and a pasted link land on the same
 * screen.
 */
/**
 * Was this the person stopping the work, rather than the work going wrong?
 *
 * The agent answers a cancelled run with the same shape as a failed one — a machine code on a
 * rejected promise — so the only thing separating "I pressed stop" from "it broke" is which
 * code it is.
 */
function deliberateStop(cause: unknown): boolean {
  const code = cause instanceof Error ? cause.message : String(cause);
  return code === 'PROCESS_CANCELED' || code === 'DOWNLOAD_CANCELED' || code === 'PREVIEW_CANCELED';
}

/**
 * What a re-stitched download is doing, in words and as a share.
 *
 * The shares are the honest shape of the work rather than a guess at seconds: the transfer is
 * most of a prepared delivery, and the cut that follows it is quick. They only ever move
 * forward, which is what the panel needs.
 */
const RESTITCH_PHASE_KEYS = {
  choosing: 'teamRestitchPhaseChoosing',
  transferring: 'teamRestitchPhaseTransferring',
  inspecting: 'teamRestitchPhaseInspecting',
  stitching: 'teamRestitchPhaseStitching',
  saving: 'teamRestitchPhaseSaving'
} as const;

/*
 * Where a step starts and how much of the bar it owns.
 *
 * The agent reports each step's own percentage now — bytes while the video arrives, the join
 * while it is stitched — so the bar is that percentage placed inside the step's own share of
 * the whole. Fetching and stitching are the two real waits and take the bar between them;
 * the rest are moments.
 */
const RESTITCH_PHASE_SPAN = {
  choosing: { from: 0, to: 5 },
  transferring: { from: 5, to: 45 },
  inspecting: { from: 45, to: 50 },
  stitching: { from: 50, to: 95 },
  saving: { from: 95, to: 100 }
} as const;

function restitchProgress(phase: keyof typeof RESTITCH_PHASE_SPAN, within?: number): number {
  const span = RESTITCH_PHASE_SPAN[phase];
  if (within === undefined) return span.from;
  const fraction = Math.max(0, Math.min(100, within)) / 100;
  return Math.round(span.from + (span.to - span.from) * fraction);
}

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
  onProcessLibrary,
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
  onProcessSelection?: (materialIds: string[], scope?: LibraryBatchScope) => void;
  onProcessLibrary?: () => void;
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
        onProcessLibrary={onProcessLibrary}
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
  onProcessLibrary,
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
  onProcessSelection?: (materialIds: string[], scope?: LibraryBatchScope) => void;
  onProcessLibrary?: () => void;
  onChanged?: () => void;
  onReset?: () => void;
  actionsClient: MaterialActionsClient;
  readOnly: boolean;
}) {
  const { t } = useI18n();
  const { push, update, dismiss } = useToasts();
  /* 015 — one running re-stitched delivery per material, held here rather than in the row:
     a delivery outlives the menu that started it and the row that scrolled past. */
  const restitch = useRestitchDelivery(teamId);
  /*
   * The one delivery worth a panel.
   *
   * Only ever one runs at a time — the menu starts a single file — so the first running state
   * is the answer, and the toasts keep carrying everything that has already finished.
   */
  const deliveringMaterial = useMemo(() => {
    for (const [materialId, state] of Object.entries(restitch.states)) {
      if (state.kind === 'running') return { materialId, state };
    }
    return null;
  }, [restitch.states]);
  /*
   * Several videos, one at a time.
   *
   * A re-stitch is the heaviest thing this machine does — it reads a whole file and writes
   * another — so a selection of five started at once would fight itself for the same cores
   * and finish later than five in a row. The panel shows whichever is running; the rest wait
   * their turn, and a failure stops that video rather than the queue.
   */
  const deliverRestitched = useCallback(
    async (rows: TeamMaterialRow[]) => {
      for (const row of rows) {
        if (row.category !== 'video') continue;
        await restitch
          .deliver({ materialId: row.id, fileName: row.name, driveVersion: row.driveVersion })
          .catch(() => {
            // Each delivery already reports its own outcome; one refusal is not the others'.
          });
      }
    },
    [restitch]
  );
  /* The delivery that met an unconfigured space waits for the settings to close, then
     continues by itself — the member gets the file they asked for without a second click. */
  const settingsOpen = query?.settings === true;
  const settingsWasOpen = useRef(false);
  useEffect(() => {
    if (settingsWasOpen.current && !settingsOpen && restitch.pending) void restitch.resume();
    settingsWasOpen.current = settingsOpen;
  }, [settingsOpen, restitch]);
  const { permissions: loadedPermissions, activeTeam } = useTeam();
  // Every write goes dark while storage needs a person (FR-033); nothing is lost.
  const permissions = readOnly ? null : loadedPermissions;
  const explorer = useExplorer();
  const {
    currentFolderId,
    selectedId,
    select,
    selectedRows: selectedRowsMap,
    clearSelection,
    pathTo,
    nodeOf
  } = explorer;
  const [treeOpen, setTreeOpen] = useState(false);
  const [processing, setProcessing] = useState<{ row: TeamMaterialRow } | null>(null);
  /*
   * The card's live transcription progress used to have a second source: a
   * `tool` on this state that nothing ever set, so the branch that read it, the
   * state it wrote and its setter were all unreachable. The queue below is the
   * one source now — it is what actually runs a transcription here.
   */
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
  const [tActive, setTActive] = useState<(QueueItem & { operationId: string | null }) | null>(null);
  const [tDone, setTDone] = useState(0);
  const [tTotal, setTTotal] = useState(0);
  // The batch is held: nothing new starts, and the file already in flight is
  // suspended too when the local app can do that (`tHeld`). Both are needed —
  // a pause that leaves the machine at full load for the next twenty minutes
  // is not the pause anyone pressed.
  const [tPaused, setTPaused] = useState(false);
  const [tHeld, setTHeld] = useState(false);
  /** The operation this browser has already asked the local app to hold. */
  const heldAsked = useRef<string | null>(null);
  // Cmd/Ctrl+C/X/V: what was copied or cut, held until the next paste. Files
  // from any folder — paste lands them in the folder currently open.
  const clipboard = useRef<{
    mode: 'copy' | 'cut';
    /** Category as well as kind: what travels with a file depends on it. */
    items: { id: string; name: string; kind: string; category: string | null }[];
  } | null>(null);
  /* A row from the list or the folder that is open — the batch needs a name
     and a drive id, and both kinds of thing carry those. */
  /* Reading a folder's subtree, and what the answer is for. All three of the
     folder-wide commands need the same walk, so they share one window. */
  const [folderScope, setFolderScope] = useState<{
    folder: ProcessableFolder;
    intent: 'process' | 'compress' | 'previews';
  } | null>(null);
  const [compressing, setCompressing] = useState<CompressPlanItem_[] | null>(null);
  const [dropping, setDropping] = useState(false);
  /** How many files are still going up; the zone stays lit while any is. */
  const [uploading, setUploading] = useState(0);
  /**
   * The name collision the drop is waiting on, and the promise the upload loop
   * is parked on until it is answered. One at a time: a drop of ten files with
   * ten collisions asks once and offers to apply that answer to the rest.
   */
  const [conflict, setConflict] = useState<{
    request: UploadConflictRequest;
    settle: (choice: UploadConflictChoice, forRest: boolean) => void;
  } | null>(null);
  const [storageKind, setStorageKind] = useState<TeamAnalyticsStorage | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const view: ExplorerView = query.view ?? readRememberedView();
  const [sort, setSortState] = useState<ExplorerSort>(() => readRememberedSort());
  const setSort = (next: ExplorerSort) => {
    rememberSort(next);
    setSortState(next);
  };
  /*
   * A tag is a shared judgement about a file, so it is the space owner's to
   * make and everyone else's to read (011). The database refuses anyone else
   * outright; this is what keeps the dot from looking pressable to them.
   */
  const canTag = !readOnly && activeTeam?.role === 'owner' && Boolean(client.setMaterialTag);
  const searching = query.q.length > 0 || query.scope === 'space';
  const page = useFolderPage({
    teamId,
    client,
    parentFolderId: currentFolderId,
    kinds: query.kinds,
    revision
  });
  const sortedRows = useMemo(() => sortRows(page.rows, sort), [page.rows, sort]);

  /**
   * Which of the videos in view have already been looked at.
   *
   * One read for the whole page rather than one per row, and re-read when the page changes so
   * a material that was just prepared elsewhere stops claiming otherwise (FR-021).
   */
  const [preparedIds, setPreparedIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const videos = page.rows.filter(row => row.kind === 'video');
    if (videos.length === 0) {
      setPreparedIds(new Set());
      return;
    }
    let active = true;
    void teamApi
      .getMaterialRestitchPrep(
        teamId,
        videos.map(row => row.id)
      )
      .then(found => {
        if (!active) return;
        const ready = new Set<string>();
        for (const row of videos) {
          const prep = usablePrep(found.get(row.id) ?? null, row.driveVersion);
          if (prep && !prep.unsupportedReason) ready.add(row.id);
        }
        setPreparedIds(ready);
      })
      .catch(() => {
        // Not knowing is the same as not prepared: the menu simply says nothing.
      });
    return () => {
      active = false;
    };
  }, [teamId, page.rows]);
  // Drive has no picture for some videos and never will. The paired app makes
  // one, for what is on screen, one at a time.
  usePosterFrames({
    teamId,
    rows: page.rows,
    enabled: agentCtx?.teamWorkspaceAvailable === true && !readOnly,
    onRendered: () => void page.reload()
  });

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

  /*
   * Every file operation in this screen goes through the tail module, and it
   * needs exactly these four. Built once so a drag, a paste, a menu and a
   * delete cannot drift apart in what they remember to carry.
   */
  const tailClient = useMemo<TailClient>(
    () => ({
      copyMaterial: input => teamApi.copyMaterial(input),
      moveMaterial: input => actionsClient.moveMaterial(input),
      renameMaterial: input => actionsClient.renameMaterial(input),
      trashMaterial: input => actionsClient.trashMaterial(input)
    }),
    [actionsClient]
  );

  /** What the tail module needs to know about a row the drag only names by id. */
  const rowFor = useCallback(
    (materialId: string) => {
      const row = page.rows.find(candidate => candidate.id === materialId);
      return { id: materialId, name: row?.name ?? '', category: row?.category ?? null };
    },
    [page.rows]
  );

  const changed = useCallback(() => {
    onChanged?.();
    void page.reload();
  }, [onChanged, page]);

  /*
   * A trashed video takes its transcript with it, without asking (owner,
   * 2026-09-02). 012 asked the question because a transcript might have been
   * shared; it never is — each video owns one, and a copy gets its own — so the
   * question only stood between a person and the tidy-up they had already
   * asked for. Both files are recoverable from the trash.
   */

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
          await moveMaterialWithTail({
            teamId,
            material: rowFor(materialId),
            destinationFolderId: folderDriveId,
            conflictMode: 'keep_both',
            client: tailClient
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
      changed,
      clearSelection,
      currentFolderId,
      nodeOf,
      permissions?.edit,
      push,
      t,
      tailClient,
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
      /*
       * Each file says it is being sent from the moment it is dropped.
       *
       * A drop used to do nothing visible: the highlight left with the pointer
       * and the next thing on screen was a message, seconds later, that said
       * only "try again in a moment". A person could not tell whether the drop
       * had even been taken. One notice per file now carries its whole life —
       * sent, landed, or refused with the reason and the file's own name — and
       * the zone stays lit while any of them is in flight.
       */
      /*
       * What the folder already holds, by name. The rows are already on screen,
       * so the question can be asked before a byte moves — and the material id
       * is right there, which is what makes "replace" a new version of that
       * file rather than a second one beside it.
       */
      const byName = new Map(page.rows.map(row => [row.name.toLocaleLowerCase(), row]));
      let forAll: UploadConflictChoice | null = null;
      setUploading(count => count + list.length);
      for (const [index, file] of list.entries()) {
        const clash = byName.get(file.name.toLocaleLowerCase());
        let choice: UploadConflictChoice = 'keep_both';
        if (clash) {
          choice =
            forAll ??
            (await new Promise<UploadConflictChoice>(resolve => {
              setConflict({
                request: {
                  fileName: file.name,
                  existingMaterialId: clash.id,
                  remaining: list.length - index - 1
                },
                settle: (answer, forRest) => {
                  if (forRest) forAll = answer;
                  setConflict(null);
                  resolve(answer);
                }
              });
            }));
        }
        if (choice === 'skip') {
          setUploading(count => Math.max(0, count - 1));
          push({ tone: 'info', text: t('teamExplorerUploadSkipped', { name: file.name }) });
          continue;
        }
        const notice = push({
          tone: 'info',
          sticky: true,
          text: t('teamExplorerUploading', { name: file.name })
        });
        try {
          await uploadTeamFile({
            teamId,
            destinationFolderId: destination,
            file,
            conflictMode: 'keep_both',
            replaceMaterialId: null,
            // Replacing is a new version of the file already there: it keeps
            // its place, its tags and what came before it.
            versionOfMaterialId: choice === 'replace' && clash ? clash.id : null
          });
          update(notice, {
            tone: 'success',
            sticky: false,
            text: t('teamExplorerUploadedOne', { name: file.name })
          });
        } catch (cause) {
          update(notice, {
            tone: 'error',
            sticky: false,
            text: t('teamExplorerUploadFailedFor', {
              name: file.name,
              reason: teamErrorMessageFor(cause, t)
            })
          });
        } finally {
          setUploading(count => Math.max(0, count - 1));
          // Each file lands on its own: what has arrived is on screen before
          // the next one starts, rather than the whole drop appearing at the
          // end of the last transfer.
          changed();
        }
      }
    },
    [changed, currentFolderId, page.rows, permissions?.upload, push, t, teamId, update]
  );

  const actions: RowActionsProps | undefined = permissions
    ? {
        teamId,
        permissions,
        browseClient: client,
        actionsClient,
        storageKind,
        onChanged: changed,
        preparedIds,
        ...(permissions.download
          ? {
              onDownloadRestitched: (row: TeamMaterialRow) => void deliverRestitched([row])
            }
          : {}),
        ...(permissions.process
          ? {
              onProcess: (row: TeamMaterialRow) => setProcessing({ row }),
              onProcessFolder: (row: TeamMaterialRow) =>
                setFolderScope({ folder: row, intent: 'process' })
            }
          : {})
      }
    : undefined;

  // The batch spans folders, so it comes from the accumulated selection map
  // rather than only the rows on the current page.
  const selectedRows = useMemo(() => Array.from(selectedRowsMap.values()), [selectedRowsMap]);
  /* The videos in the selection, once: three of the bar's actions ask for exactly this
     and one of them decides whether it is offered at all. */
  const selectedVideos = useMemo(
    () => selectedRows.filter(row => row.category === 'video'),
    [selectedRows]
  );
  /*
   * What the batch can actually take. A folder, a transcript or an image can be
   * checked like anything else, and passing those on gave a window titled
   * "Обробка: обрано 1" that scanned nothing and then said "everything is
   * already current" — which reads as done, not as "not a thing I process".
   */
  /*
   * How many of the selection are not on screen — measured against the rows
   * shown, not against the folder id.
   *
   * At the root `currentFolderId` is null while every row carries the drive's
   * real root id, so comparing ids called three tiles in plain view "3 з інших
   * папок". This is also the truer sentence: a selected row hidden by a kind
   * filter, or waiting behind "Показати ще", is out of sight wherever it lives.
   */
  const elsewhere = useMemo(
    () => selectedRows.filter(row => !page.rows.some(shown => shown.id === row.id)).length,
    [page.rows, selectedRows]
  );
  const processableRows = useMemo(
    () => selectedRows.filter(row => row.category === 'video' || row.category === 'landing'),
    [selectedRows]
  );
  const focused = page.rows.find(row => row.id === selectedId) ?? null;

  /**
   * The original, saved to this computer.
   *
   * The same two doors the row menu already uses: the paired app when the cloud says the file
   * is its business, the browser otherwise. Repeated here rather than reached for through the
   * row menu's hook, because the card is not a row and has no menu to borrow from.
   */
  const downloadOriginal = useCallback(
    async (row: TeamMaterialRow) => {
      try {
        const grant = await teamApi.requestDownload(teamId, row.id, 'browser');
        if (grant.kind === 'agent') {
          await downloadTeamFileWithAgent({
            transferUrl: grant.transferUrl,
            transferGrant: grant.grant,
            fileName: row.name
          });
          push({ tone: 'success', text: t('teamRestitchDelivered', { name: row.name }) });
          return;
        }
        const anchor = document.createElement('a');
        anchor.href = grant.rangeUrl;
        anchor.download = row.name;
        anchor.rel = 'noreferrer';
        anchor.click();
      } catch (cause) {
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      }
    },
    [push, t, teamId]
  );

  /** Rows going to the trash from the keyboard or the selection bar, with the way back. */
  const trashRows = useCallback(
    async (rows: TeamMaterialRow[]) => {
      if (!permissions?.delete) return;
      const trashed: string[] = [];
      /* Folders do not go to the trash — Drive has no such move for them here.
         Silently dropping them meant the bin did nothing at all over a
         selection of folders: no toast, no error, the selection still there. */
      const folders = rows.filter(row => row.kind === 'folder').length;
      if (folders === rows.length) {
        push({ tone: 'info', text: t('teamExplorerTrashFoldersOnly') });
        return;
      }
      for (const row of rows) {
        if (row.kind === 'folder') continue;
        try {
          // The transcript goes with its video, here as everywhere else.
          await trashMaterialWithTail({
            teamId,
            material: { id: row.id, name: row.name, category: row.category },
            client: tailClient
          });
          trashed.push(row.id);
        } catch (cause) {
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          break;
        }
      }
      if (trashed.length === 0) return;
      if (folders > 0)
        push({ tone: 'info', text: t('teamExplorerTrashSkippedFolders', { count: folders }) });
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
    [
      actionsClient,
      changed,
      clearSelection,
      permissions?.delete,
      push,
      select,
      t,
      tailClient,
      teamId
    ]
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
    if (tActive || tQueue.length === 0 || tPaused) return;
    const next = tQueue[0];
    setTActive({ ...next, operationId: null });
    void (async () => {
      let started: string | null = null;
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
        started = result.operationId;
        const finished = await startTeamAgentProcess({
          operationId: result.operationId,
          toolId: next.tool,
          options: next.options ?? {},
          sourceGrant: result.sourceGrant,
          finalizeGrant: result.finalizeGrant
        });
        /*
         * A transcript is named after its video, including the second time.
         *
         * A repeat is written while the transcript it replaces is still there,
         * so the name it asked for is taken and the conflict rule hands it
         * "16-tail (2).txt". The old one is retired during that same finalize —
         * which frees the name — and the file keeps the parenthesis forever,
         * one more each time. Asking for the canonical name here costs one call
         * and is refused (never duplicated) if something live still holds it.
         */
        if (next.tool === 'transcription' && finished.materialId) {
          await actionsClient
            .renameMaterial({
              teamId,
              materialId: finished.materialId,
              newName: next.outputName,
              conflictMode: 'cancel',
              idempotencyKey: crypto.randomUUID()
            })
            .catch(() => undefined);
        }
      } catch (cause) {
        // A run somebody stopped on purpose is not a failure, and saying so in red is how a
        // deliberate act starts looking like a fault. Everything below still happens — the
        // space is told the run is over either way.
        if (!deliberateStop(cause)) push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        // Tell the space the run is over. Without this a failed item stays
        // `running` for good: nothing else ever revisits it, it holds its
        // output name reserved, and the next attempt at the same file is
        // refused for a conflict with a run that is not happening.
        if (started) await teamApi.cancelOperation(teamId, started).catch(() => undefined);
      } finally {
        setTDone(current => current + 1);
        setTActive(null);
        setTQueue(current => current.slice(1));
        changed();
      }
    })();
  }, [actionsClient, agentCtx?.toolContracts, changed, push, t, tActive, tPaused, tQueue, teamId]);

  // The queue drained: one closing toast, counters reset. A pause dies with the
  // queue it was holding; leaving it set would silently swallow the next batch.
  useEffect(() => {
    if (tActive || tQueue.length > 0 || tTotal === 0) return;
    push({ tone: 'success', text: t('teamTranscribeQueueDone', { count: tDone }) });
    setTDone(0);
    setTTotal(0);
    setTPaused(false);
    setTHeld(false);
  }, [push, t, tActive, tDone, tQueue.length, tTotal]);

  /**
   * Holds the batch, and the running file with it where that is possible.
   *
   * The local app is asked separately from the queue on purpose: an older build,
   * a transfer rather than an encode, or the moment between two children all
   * answer "nothing held", and the panel then says the current file is finishing
   * rather than claiming a quiet machine it cannot deliver.
   */
  const pauseQueue = useCallback(
    (paused: boolean) => {
      setTPaused(paused);
      const operationId = tActive?.operationId ?? null;
      heldAsked.current = paused ? operationId : null;
      if (!operationId) {
        setTHeld(false);
        return;
      }
      void pauseTeamAgentProcess(operationId, paused)
        .then(held => setTHeld(paused && held))
        .catch(() => setTHeld(false));
    },
    [tActive?.operationId]
  );

  /*
   * A hold the local app keeps only while this page keeps asking for it.
   *
   * A reload does not close the request the run is riding on — the socket stays
   * open and the agent keeps working, which is why a refresh costs no work. The
   * pause would survive that reload too, with nothing left to lift it, so the
   * page says "still paused" every half minute and the agent lets go on its own
   * if that stops arriving.
   */
  useEffect(() => {
    const operationId = tActive?.operationId ?? null;
    if (!tPaused || !tHeld || !operationId) return;
    const timer = window.setInterval(() => {
      void pauseTeamAgentProcess(operationId, true).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [tActive?.operationId, tHeld, tPaused]);

  // Pause pressed in the second between "started" and "the operation has an
  // id": there was nothing to hold then, so the hold is taken as soon as there
  // is. Asked once per operation — an agent that cannot hold has answered, and
  // repeating the question on every render would be a request per frame.
  useEffect(() => {
    const operationId = tActive?.operationId ?? null;
    if (!tPaused || !operationId || tHeld || heldAsked.current === operationId) return;
    heldAsked.current = operationId;
    void pauseTeamAgentProcess(operationId, true)
      .then(held => setTHeld(held))
      .catch(() => undefined);
  }, [tActive?.operationId, tHeld, tPaused]);

  /**
   * Abandons the file being worked on, and everything queued behind it.
   *
   * The pause is lifted first: a stopped process is not delivered its termination signal
   * until it runs again, so cancelling a held run would otherwise wait for a resume nobody
   * is coming to give it.
   */
  const stopNow = useCallback(async () => {
    const operationId = tActive?.operationId ?? null;
    setTQueue([]);
    if (tPaused) pauseQueue(false);
    if (!operationId) return;
    await cancelTeamAgentProcess(operationId).catch(() => false);
  }, [pauseQueue, tActive?.operationId, tPaused]);

  /**
   * Painted first, written after: a dot that waits for a round trip before it
   * changes reads as a press that did not land, and this is the cheapest write
   * on the screen. A refusal puts the old colour back and says so.
   */
  const setTag = useCallback(
    async (row: TeamMaterialRow, color: TeamMaterialTagColor | null) => {
      if (!client.setMaterialTag) return;
      const previous = row.tagColor ?? null;
      page.patchRow(row.id, { tagColor: color });
      try {
        await client.setMaterialTag({ teamId, materialId: row.id, color });
      } catch (cause) {
        page.patchRow(row.id, { tagColor: previous });
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      }
    },
    [client, page, push, t, teamId]
  );
  const tagging = canTag ? { canTag: true as const, onSetTag: setTag } : undefined;

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
        ...(plan.destination.kind === 'local' ? { local: { embed: plan.embed, suffix } } : {}),
        options: plan.embed ? { imageEmbedding: { enabled: true } } : {}
      };
    });
    enqueueJobs(jobs);
  };

  /**
   * Landing previews, folder-wide: the same per-row command, said once.
   *
   * It used to announce success before doing anything and swallow every
   * failure — six previews that all failed on an expired connection read as
   * "оновлюємо: 6" and nothing else, ever. The line counts as it goes and ends
   * on what actually happened.
   */
  const refreshLandingPreviews = (landingIds: string[]) => {
    if (landingIds.length === 0) return;
    const line = push({
      tone: 'info',
      sticky: true,
      progress: 0,
      text: t('teamExplorerPreviewsRunning', { done: 0, total: landingIds.length })
    });
    void (async () => {
      let done = 0;
      let failed = 0;
      for (const id of landingIds) {
        try {
          await teamApi.regenerateLandingPreview(teamId, id);
          done += 1;
        } catch {
          failed += 1;
        }
        update(line, {
          progress: ((done + failed) / landingIds.length) * 100,
          text: t('teamExplorerPreviewsRunning', { done: done + failed, total: landingIds.length })
        });
      }
      update(line, {
        tone: failed > 0 ? 'error' : 'success',
        sticky: false,
        progress: undefined,
        text:
          failed > 0
            ? t('teamExplorerPreviewsPartial', { done, failed })
            : t('teamExplorerPreviewsDone', { count: done })
      });
      if (done > 0) changed();
    })();
  };

  const pasteClipboard = async () => {
    const clip = clipboard.current;
    if (!clip) return;
    if (clip.mode === 'copy' && !permissions?.upload) return;
    if (clip.mode === 'cut' && !permissions?.edit) return;
    // The Drive API cannot copy folders; a cut (move) handles them fine.
    const items =
      clip.mode === 'copy' ? clip.items.filter(item => item.kind !== 'folder') : clip.items;
    const skipped = clip.items.length - items.length;
    if (items.length === 0) {
      push({ tone: 'error', text: t('teamExplorerPasteFoldersOnly') });
      return;
    }
    let done = 0;
    // Copying a file is a Drive-side operation per file, and each one brings its
    // transcript with it — twenty pasted videos is forty round trips. A single
    // line that counts is the difference between "nothing is happening" and
    // "this is going to take a moment".
    const progress = push({
      tone: 'info',
      sticky: true,
      progress: 0,
      text: t(clip.mode === 'copy' ? 'teamExplorerPastingCopy' : 'teamExplorerPastingMove', {
        done: 0,
        total: items.length
      })
    });
    for (const item of items) {
      try {
        const material = { id: item.id, name: item.name, category: item.category };
        if (clip.mode === 'copy') {
          await copyMaterialWithTail({
            teamId,
            material,
            destinationFolderId: currentFolderId ?? null,
            client: tailClient
          });
        } else {
          await moveMaterialWithTail({
            teamId,
            material,
            destinationFolderId: currentFolderId ?? null,
            conflictMode: 'keep_both',
            client: tailClient
          });
        }
        done += 1;
        update(progress, {
          progress: (done / items.length) * 100,
          text: t(clip.mode === 'copy' ? 'teamExplorerPastingCopy' : 'teamExplorerPastingMove', {
            done,
            total: items.length
          })
        });
      } catch (cause) {
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        break;
      }
    }
    if (clip.mode === 'cut') clipboard.current = null;
    if (done > 0) {
      changed();
      clearSelection();
      update(progress, {
        tone: 'success',
        sticky: false,
        progress: undefined,
        text: t('teamExplorerPastedCount', { count: done })
      });
      if (skipped > 0) {
        push({ tone: 'error', text: t('teamExplorerPasteFoldersSkipped', { count: skipped }) });
      }
    } else {
      dismiss(progress);
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
          items: rows.map(row => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            category: row.category
          }))
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
    /* The handler reads the current selection and the open folder, and this
       component re-renders on every toast and every page. With no dependency
       list at all a document-level listener was torn down and rebuilt on each
       of those. */
  }, [focused, pasteClipboard, push, readOnly, searching, selectedRows, t, trash]);

  return (
    /* `team-panel`, like Accounts and Tasks: this was the one tab in the space
       with no card under it, so the marketing honeycomb showed through every
       gutter — and then a card appeared out of nowhere the moment somebody
       pressed Search, because that view brought its own. One card now, and the
       views inside it no longer carry their own. */
    <div
      /*
       * The selected-file pane belongs to a folder listing. In a search or the
       * trash nothing feeds it, so it stood there saying "Оберіть файл, щоб
       * побачити його тут." and took three hundred and forty pixels of the one
       * column that needed them — the search results were folding their actions
       * under every hit for want of that width.
       */
      className={`team-panel team-explorer${trash || searching ? '' : ' has-pane'}${
        treeOpen ? ' is-tree-open' : ''
      }`}
    >
      <FolderTree
        elsewhere={trash || searching}
        onDropMaterials={(folder, ids) => void moveTo(folder, ids)}
        onReset={onReset}
      />
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
              <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}>
                {t('teamExplorerAddFiles')}
              </Button>
            </>
          )}
          {/*
           * Processing a whole folder or a whole space was reachable only
           * through an unlabelled ▶ that appeared after something was selected
           * — and that button then ignored the selection anyway. It is a door
           * in the toolbar now, open before anything is chosen, and it names
           * the two scopes that actually exist.
           */}
          {permissions?.process && !trash && !searching && (
            <ProcessMenu
              folder={currentFolderId ? explorer.nodeOf(currentFolderId) : null}
              onFolder={folder => setFolderScope({ folder, intent: 'process' })}
              onCompressFolder={
                permissions?.upload
                  ? folder => setFolderScope({ folder, intent: 'compress' })
                  : undefined
              }
              onRefreshFolderPreviews={folder => setFolderScope({ folder, intent: 'previews' })}
              onSpace={onProcessLibrary}
            />
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
        className={`team-explorer-main team-explorer-dropzone${dropping ? ' is-over' : ''}${
          uploading > 0 ? ' is-uploading' : ''
        }`}
        aria-busy={uploading > 0 || undefined}
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
          /*
           * What to do with a selection, in the compressor's idiom.
           *
           * It was five full-width buttons of prose that wrapped onto three lines above the
           * files and pushed them down the page — the bar meant to help was the widest thing
           * on the screen. Each action is now the icon it already has elsewhere in this
           * workspace, named on hover and to a screen reader; the count leads, and the way out
           * sits at the far end where a dismissal belongs.
           */
          <div
            className="team-explorer-selection-bar"
            role="region"
            /* A static name: it used to be the same string as the count beside
               it, so a screen reader said "Обрано: 3" twice on entry. */
            aria-label={t('teamExplorerSelectionRegion')}
          >
            <span className="team-explorer-selection-count">
              {t('teamExplorerSelectedCount', { count: selectedRows.length })}
              {/* The selection survives walking into another folder, which is
                  what makes it useful and what makes the bin a surprise: three
                  of the five being acted on can be two folders back. */}
              {elsewhere > 0 && (
                <span className="team-explorer-selection-elsewhere">
                  {t('teamExplorerSelectedElsewhere', { count: elsewhere })}
                </span>
              )}
            </span>
            <div className="team-explorer-selection-actions">
              {onCreateTaskFromSelection && (
                <SelectionAction
                  label={t('teamExplorerCreateTaskFromSelection')}
                  onClick={() =>
                    onCreateTaskFromSelection(
                      selectedRows.map(row => ({ id: row.id, name: row.name }))
                    )
                  }
                >
                  <ListPlus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </SelectionAction>
              )}
              {/*
               * The selection, whatever its size. This used to say "Process…"
               * over four files and quietly start work on the entire space —
               * the selection was never passed anywhere — so it was cut back
               * to one file. Now the ids travel with the press, and the count
               * in the label is the count of files the batch can take.
               */}
              {onProcessSelection && permissions?.process && processableRows.length > 0 && (
                <SelectionAction
                  primary
                  label={
                    processableRows.length === 1
                      ? t('teamExplorerProcessSelection')
                      : t('teamExplorerProcessSelectionMany', { count: processableRows.length })
                  }
                  onClick={() => {
                    /* The same bound the folder path already respects: the
                       scan and the claim refuse a scope over five hundred, and
                       the selection survives folder changes, so it can get
                       there. Refused here, it is a sentence; refused by the
                       RPC, it is "Частина даних некоректна" in a window with
                       no fields. */
                    if (processableRows.length > BATCH_SCOPE_LIMIT) {
                      push({
                        tone: 'error',
                        text: t('teamBatchFolderTooMany', {
                          count: processableRows.length,
                          limit: BATCH_SCOPE_LIMIT
                        })
                      });
                      return;
                    }
                    onProcessSelection(
                      processableRows.map(row => row.id),
                      {
                        kind: 'selection',
                        count: processableRows.length,
                        ...(processableRows.length < selectedRows.length
                          ? { picked: selectedRows.length }
                          : {})
                      }
                    );
                  }}
                >
                  <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </SelectionAction>
              )}
              {permissions?.process && selectedVideos.length > 0 && (
                <SelectionAction
                  label={t('teamCompressSelected')}
                  onClick={() =>
                    setCompressing(
                      selectedVideos.map(row => ({
                        id: row.id,
                        name: row.name,
                        folderId: row.parentFolderId ?? currentFolderId ?? null
                      }))
                    )
                  }
                >
                  <Shrink size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </SelectionAction>
              )}
              {permissions?.download && selectedVideos.length > 0 && (
                <SelectionAction
                  label={t('teamRestitchDownloadRestitched')}
                  onClick={() => void deliverRestitched(selectedVideos)}
                >
                  <Download size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </SelectionAction>
              )}
              {permissions?.delete && (
                <SelectionAction
                  label={t('teamFileTrash')}
                  destructive
                  onClick={() => void trashRows(selectedRows)}
                >
                  <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </SelectionAction>
              )}
            </div>
            <SelectionAction label={t('teamExplorerClearSelection')} onClick={clearSelection}>
              <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </SelectionAction>
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
            tagging={
              canTag && client.setMaterialTag
                ? {
                    canTag: true,
                    onSetTag: (material, color) => {
                      page.patchRow(material.id, { tagColor: color });
                      void client
                        .setMaterialTag?.({
                          teamId,
                          materialId: material.id,
                          color
                        })
                        .catch(cause =>
                          push({ tone: 'error', text: teamErrorMessageFor(cause, t) })
                        );
                    }
                  }
                : undefined
            }
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
                page={page}
                onPreview={onPreview}
                actions={actions}
                sort={sort}
                tagging={tagging}
              />
            ) : (
              <ContentList
                page={page}
                onPreview={onPreview}
                actions={actions}
                sort={sort}
                tagging={tagging}
              />
            )}
          </div>
        )}
        {dropping && <p className="team-explorer-muted">{t('teamExplorerDropHint')}</p>}
      </div>
      {!trash && !searching && (
        <PreviewPane
          row={focused}
          client={client}
          onOpen={onPreview}
          onDownload={permissions?.download ? row => void downloadOriginal(row) : undefined}
          onDownloadRestitched={
            permissions?.download && focused?.kind === 'video'
              ? row => void deliverRestitched([row])
              : undefined
          }
          restitchPrepared={focused ? preparedIds.has(focused.id) : false}
          // Shared the way the tile shares: a member who can see a file can hand out a link.
          onShare={Boolean(permissions)}
          onDelete={permissions?.delete ? row => void trashRows([row]) : undefined}
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
          transcribing={tActive ? { videoId: tActive.id, progress: activeProgress } : null}
          onCreateTask={onCreateTask}
        />
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
      {folderScope && (
        <FolderScopeDialog
          teamId={teamId}
          folder={folderScope.folder}
          intent={folderScope.intent}
          client={client}
          onResolved={result => {
            const { folder, intent } = folderScope;
            setFolderScope(null);
            if (intent === 'compress') {
              if (result.videos.length === 0) return;
              setCompressing(
                result.videos.map(video => ({
                  id: video.id,
                  name: video.name,
                  folderId: video.parentFolderId ?? folder.driveFileId
                }))
              );
              return;
            }
            if (intent === 'previews') {
              refreshLandingPreviews(result.landings.map(landing => landing.id));
              return;
            }
            const ids = scopeIdsOf(result);
            /* An empty scope is not a small batch: with no ids the server reads
               the request as the whole space, so a folder that yielded nothing
               would quietly start everything. */
            if (ids.length === 0) return;
            onProcessSelection?.(ids, {
              kind: 'folder',
              name: folder.name,
              // The walk counts the folder it started from; a folder with five
              // subfolders was reporting six.
              folders: Math.max(0, result.foldersVisited - 1),
              files: ids.length,
              // Separately, because the window's "already done" line is about
              // videos with a transcript, and one video is exactly one
              // transcription job.
              videos: result.videos.length
            });
          }}
          onClose={() => setFolderScope(null)}
        />
      )}
      {/* One corner, one stack: both panels are reachable from the same
          selection, and pinned to the same pixel the second hid the first. */}
      <div className="team-process-stack">
        {(tActive || tQueue.length > 0) && (
          <ProcessPanel
            title={t(
              tActive?.tool === 'compressor' ? 'teamCompressQueueTitle' : 'teamTranscribeQueueTitle'
            )}
            detail={
              tActive
                ? t('teamTranscribeQueueProgress', {
                    done: tDone + 1,
                    total: tTotal,
                    name: tActive.name
                  })
                : null
            }
            phase={
              tPaused
                ? t(
                    tActive
                      ? tHeld
                        ? 'teamQueuePausedHeld'
                        : 'teamQueuePausedRunning'
                      : 'teamQueuePausedIdle',
                    { count: tQueue.length }
                  )
                : null
            }
            progress={activeProgress}
            active={!tPaused}
            actions={[
              {
                label: t(tPaused ? 'teamQueueResume' : 'teamQueuePause'),
                run: () => pauseQueue(!tPaused)
              },
              ...(tQueue.length > (tActive ? 0 : 1)
                ? [
                    {
                      label: t('teamTranscribeQueueStop'),
                      run: () => {
                        setTQueue(tActive ? [] : current => current.slice(0, 1));
                        setTTotal(tDone + 1);
                        // "After the current one" has to have a current one that is still
                        // moving; stopping while paused would leave a suspended file as the
                        // last thing this panel ever did.
                        if (tPaused) pauseQueue(false);
                      }
                    }
                  ]
                : []),
              ...(tActive
                ? [{ label: t('teamQueueStopNow'), run: () => void stopNow(), destructive: true }]
                : [])
            ]}
          />
        )}

        {/* 015 — a re-stitched download reports itself the same way every other long job does:
            one panel, a named step, and a way out. It used to say only "downloading…" in a
            toast, which on a thirty-second wait reads as a hang. */}
        {deliveringMaterial && (
          <ProcessPanel
            title={t('teamRestitchDownloadTitle')}
            detail={deliveringMaterial.state.fileName}
            phase={t(RESTITCH_PHASE_KEYS[deliveringMaterial.state.phase])}
            progress={restitchProgress(
              deliveringMaterial.state.phase,
              deliveringMaterial.state.progress
            )}
            active
            actions={[
              {
                label: t('teamQueueStopNow'),
                run: () => restitch.cancel(deliveringMaterial.materialId),
                destructive: true
              }
            ]}
          />
        )}
      </div>

      {/* 015 — the running deliveries speak for themselves; nothing is rendered inline. */}
      {conflict && <UploadConflictDialog request={conflict.request} onChoose={conflict.settle} />}
      <RestitchDeliveryNotices
        states={restitch.states}
        onConfigure={() =>
          navigateTo(
            buildTeamRoute({
              spaceId: teamId,
              section: 'explorer',
              query: { ...query, settings: true }
            })
          )
        }
      />
      {processing && (
        <MaterialProcessFlow
          teamId={teamId}
          material={{
            id: processing.row.id,
            name: processing.row.name,
            category: processing.row.category
          }}
          destinationFolderId={processing.row.parentFolderId ?? currentFolderId ?? null}
          browseClient={client}
          onClose={() => {
            setProcessing(null);
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

/**
 * One action on the selection: an icon, and its name where a name belongs.
 *
 * The bar used to spell each of these out in a button, and at the content column's width the
 * five of them wrapped onto three lines above the files. The names have not gone anywhere —
 * they are the tooltip and the accessible label, exactly as on a file's own card.
 */
/**
 * Where a batch is started from, and over what.
 *
 * Two scopes, because two exist: the folder that is open, walked with its
 * subfolders, and everything the space holds. Both already worked; neither had
 * a way in that a person could find without first selecting a file.
 */
function ProcessMenu({
  folder,
  onFolder,
  onCompressFolder,
  onRefreshFolderPreviews,
  onSpace
}: {
  folder: ProcessableFolder | null;
  onFolder: (folder: ProcessableFolder) => void;
  onCompressFolder?: (folder: ProcessableFolder) => void;
  onRefreshFolderPreviews?: (folder: ProcessableFolder) => void;
  onSpace?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  /*
   * Choosing an item unmounts it, and the window that opens next restores focus
   * to whatever was focused when it appeared — a detached button, which puts
   * focus on the body and loses a keyboard user's place entirely. So the
   * trigger takes focus back first, and the dialog restores to that.
   */
  const choose = (run: () => void) => {
    setOpen(false);
    button.current?.focus();
    run();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A menu that says `role="menu"` promises arrow keys; Tab alone was all it
  // had, and the first item never took focus when the menu opened.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    /* Tab leaves a menu rather than walking it — the arrows are the walk. The
       trigger takes focus first: closing on a keydown unmounts the focused item
       before the browser applies the move, and Tab from a detached element
       starts again at the top of the document. */
    if (event.key === 'Tab') {
      button.current?.focus();
      setOpen(false);
      return;
    }
    const items = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
  };

  if (!onSpace && !folder) return null;

  /*
   * At the root there is no folder, so the menu held exactly one item: a press
   * to open a list of one, then a second press to choose the only thing there.
   * With one scope the button is the scope.
   */
  if (!folder && onSpace) {
    return (
      <Button type="button" variant="secondary" onClick={onSpace}>
        {t('teamExplorerProcessEverything')}
      </Button>
    );
  }

  return (
    <div className="team-explorer-process-menu" ref={box}>
      <Button
        type="button"
        ref={button}
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {t('teamExplorerProcess')}
      </Button>
      {open && (
        <div
          className="team-explorer-menu"
          role="menu"
          aria-label={t('teamExplorerProcessScope')}
          ref={list}
          onKeyDown={onListKeyDown}
        >
          {folder && (
            <button
              type="button"
              role="menuitem"
              className="team-explorer-menu-item"
              onClick={() => choose(() => onFolder(folder))}
            >
              {t('teamExplorerProcessFolder')}
            </button>
          )}
          {folder && onCompressFolder && (
            <button
              type="button"
              role="menuitem"
              className="team-explorer-menu-item"
              onClick={() => choose(() => onCompressFolder(folder))}
            >
              {t('teamExplorerCompressFolder')}
            </button>
          )}
          {folder && onRefreshFolderPreviews && (
            <button
              type="button"
              role="menuitem"
              className="team-explorer-menu-item"
              onClick={() => choose(() => onRefreshFolderPreviews(folder))}
            >
              {t('teamFolderProcessLandings')}
            </button>
          )}
          {folder && onSpace && <hr className="team-explorer-menu-rule" aria-hidden="true" />}
          {onSpace && (
            <button
              type="button"
              role="menuitem"
              className="team-explorer-menu-item"
              onClick={() => choose(onSpace)}
            >
              {t('teamExplorerProcessSpace')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SelectionAction({
  label,
  onClick,
  destructive,
  primary,
  children
}: {
  label: string;
  onClick: () => void;
  /** The one that throws things away; coloured apart from the rest. */
  destructive?: boolean;
  /** The action this screen exists for; it keeps its word at any width. */
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`team-explorer-selection-action ${destructive ? 'is-destructive' : ''} ${
        primary ? 'is-primary' : ''
      }`.trim()}
      aria-label={label}
      data-tip={label}
      onClick={onClick}
    >
      {children}
      {/* The word is in the markup and only CSS takes it away, and only where
          the bar runs out of room. Five unlabelled icons — one of them a bin —
          asked people to guess, with four hundred pixels of the bar unused. */}
      <span className="team-explorer-selection-action-label">{label}</span>
    </button>
  );
}
