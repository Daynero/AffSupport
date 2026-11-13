import { CatalogProfileVideoCount } from './CatalogProfileVideoCount';
import { CatalogBackgroundStalledNote } from './CatalogBackgroundStalledNote';
import { CatalogVideoVariationsDialog } from './CatalogVideoVariationsDialog';
import { CatalogPublicationDialog } from '../product-catalog/CatalogPublicationDialog';
import { captureCatalogMutationOwner } from './captureCatalogMutationOwner';
import { withCatalogCommandDeadline } from './catalogCommandCoordinator';
import { useCatalogCommands, type CatalogCommandClient } from './useCatalogCommands';
import { privateClientId, usePrivateCacheEpoch } from '../private-cache-scope';
import { withReadDeadline } from '../readCoordinator';
import type { TeamAnalyticsStorage } from '@video-compressor/shared';
import { useOptionalWorkspaceOperations } from '../explorer/WorkspaceOperationsProvider';
import { BulkTrashPanel } from '../explorer/BulkTrashPanel';
import { useOptionalSpaceAgentQueue } from '../processing/AgentQueueProvider';
import { createPortal } from 'react-dom';
import { readCatalogSnapshot } from './readCatalogSnapshot';
import { TeamApiError } from '../../api/team';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  MoreHorizontal,
  Check,
  LoaderCircle,
  Search,
  X,
  RefreshCw,
  Square,
  CircleHelp,
  History,
  SlidersHorizontal
} from 'lucide-react';
import type {
  CatalogMutationOptions,
  CatalogRegistryRow,
  CatalogUpdaterInterval,
  CatalogUpdaterState
} from '../../api/team';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Checkbox, ConfirmDialog } from '../../components/ui';
import { Button, IconButton } from '../../components/ui/index';
import { SelectMenu } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { catalogDeleteConfirmKey, catalogSelectedCountKey, useI18n } from '../../i18n';
import { searchFieldEscape } from '../../lib/searchField';
import { teamErrorCodeOf, teamErrorMessage, teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { UpdaterIntervalPicker, intervalLabel } from './UpdaterIntervalPicker';
import { navigateTo, BEFORE_NAVIGATION_EVENT } from '../../lib/navigation';
import { spaceRouteFor } from '../SpaceSettingsLink';
import { DropdownMenu } from '../../components/ui/index';
import { beginCatalogUiFlow, type CatalogUiFlow, type CatalogUiFailure } from './analytics';
import { UpdaterRowActions } from './UpdaterRowActions';
import { CatalogProgressRow } from './CatalogProgressRow';
import { CatalogRowStage } from './CatalogRowStage';
import { CatalogRowPublicationNote } from './CatalogRowPublicationNote';
import { CatalogUpdateProgress } from './CatalogUpdateProgress';
import { CatalogIdentity } from './CatalogIdentity';
import { LazyCatalogRenameDialog } from '../product-catalog/LazyCatalogRenameDialog.js';
import {
  CatalogIconControls,
  CatalogIconLegend,
  CATALOG_FIELDS,
  catalogVideoR2Sentence
} from './CatalogIconControls';
import { useCatalogVideoR2Team } from '../product-catalog/useCatalogVideoR2Team';
import { useCatalogInlineChanges, type CatalogField } from './useCatalogInlineChanges';
import { CatalogCreatedFilter } from './CatalogCreatedFilter';
import { matchesCatalogCreatedAt } from './catalogCreatedDate';
import { CatalogStatusDetails } from './CatalogStatusDetails';
import { CatalogBulkEditor } from './CatalogBulkEditor';
import {
  filterCatalogRows,
  useCatalogRegistry,
  useCatalogUpdater,
  type CatalogUpdaterClient
} from './useCatalogUpdater';

export interface CatalogUpdaterDialogClient extends CatalogUpdaterClient, CatalogCommandClient {
  getConnectionStatus?: (teamId: string) => Promise<{ driveKind?: TeamAnalyticsStorage | null }>;
  setCatalogUpdateInterval: (
    teamId: string,
    catalogIds: string[],
    interval: CatalogUpdaterInterval | null
  ) => Promise<CatalogUpdaterState>;
  runCatalogUpdateNow: (teamId: string, catalogIds: string[]) => Promise<number>;
  cancelCatalogUpdate?: (
    teamId: string,
    catalogId: string,
    observed?: { roundAt: string; attemptId: string | null },
    options?: CatalogMutationOptions
  ) => Promise<boolean>;
  listCatalogUpdateAttempts?: (
    teamId: string,
    catalogId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<import('@video-compressor/shared').CatalogUpdateAttempt[]>;
  retryCatalogUpdate?: (
    teamId: string,
    catalogId: string,
    sourceAttemptId: string
  ) => Promise<number>;
  setCatalogUpdaterRestitch: (teamId: string, restitch: boolean) => Promise<CatalogUpdaterState>;
  getCatalogUpdaterRestitchDefault?: (teamId: string) => Promise<boolean>;
  getCatalogUpdaterRefreshImages?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterRefreshImages?: (teamId: string, refresh: boolean) => Promise<boolean>;
  getCatalogUpdaterRefreshTexts?: (teamId: string) => Promise<boolean>;
  getCatalogUpdaterRandomLinkVariation?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterRandomLinkVariation?: (teamId: string, enabled: boolean) => Promise<boolean>;
  setCatalogUpdaterRefreshTexts?: (teamId: string, refresh: boolean) => Promise<boolean>;
  getCatalogUpdaterGrow?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterGrow?: (teamId: string, grow: boolean) => Promise<boolean>;
}

const defaultClient: CatalogUpdaterDialogClient = teamApi;
function lastSuccess(row: CatalogRegistryRow): string | null {
  return row.profile?.lastSuccessfulAt === undefined
    ? row.lastUpdatedAt
    : row.profile.lastSuccessfulAt;
}

// Profile options configure the next run; the current stage belongs to the accepted run.
function needsVideo(row: CatalogRegistryRow) {
  if (row.updatePending && row.updateStage) {
    return row.updateStage === 'waiting_video' || row.updateStage === 'restitching';
  }
  return Boolean(row.profile?.restitch);
}

function needsAttention(row: CatalogRegistryRow) {
  if (row.profile?.reconciliationRequired) return row.profile.lastResult !== 'running';
  if (row.updatePending)
    return Boolean(
      needsVideo(row) &&
      row.profile?.restitchStatus === 'blocked' &&
      row.profile?.restitchBlockedCode
    );
  return Boolean(
    row.lastUpdateError ||
    ['failed', 'partial', 'unknown'].includes(row.profile?.lastResult ?? '') ||
    (needsVideo(row) && row.profile?.restitchStatus === 'blocked')
  );
}

export function CatalogUpdaterDialog(props: Parameters<typeof CatalogUpdaterDialogScope>[0]) {
  const epoch = usePrivateCacheEpoch();
  return (
    <CatalogUpdaterDialogScope
      key={`${props.teamId}:${privateClientId(props.client ?? defaultClient)}:${epoch}`}
      {...props}
    />
  );
}

function CatalogUpdaterDialogScope({
  teamId,
  client = defaultClient,
  onClose,
  onChanged,
  onReveal,
  notice
}: {
  teamId: string;
  /** 034 — a line above the list: the updater the pause left off, with its switch. */
  notice?: ReactNode;
  client?: CatalogUpdaterDialogClient;
  /** This tab is preparing a re-stitched copy right now. */
  preparing?: boolean;
  onClose: () => void;
  /** Called after a change, so the chip outside the dialog reads the new state. */
  onChanged?: () => void;
  /** Close the updater and show this catalog's sheet where it lives in the space. */
  onReveal?: (row: CatalogRegistryRow) => void;
}) {
  const mounted = useRef(true);
  const stopControllers = useRef(new Set<AbortController>());
  const stopFlows = useRef(new Set<CatalogUiFlow>());
  const stopFeedback = useRef(new Map<number, { flow: CatalogUiFlow; error?: CatalogUiFailure }>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of stopControllers.current) controller.abort();
      for (const flow of stopFlows.current) flow.cancel();
      stopFlows.current.clear();
      stopFeedback.current.clear();
    };
  }, []);
  const sourceScope = useRef({ teamId, client });
  if (sourceScope.current.teamId !== teamId || sourceScope.current.client !== client)
    sourceScope.current = { teamId, client };
  const owner = useMemo(() => {
    const scope = sourceScope.current;
    return captureCatalogMutationOwner(() => mounted.current && sourceScope.current === scope);
  }, [teamId, client]);
  const [storageContext, setStorageContext] = useState<{
    teamId: string;
    kind: TeamAnalyticsStorage | null;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setStorageContext(null);
    if (client.getConnectionStatus) {
      void withReadDeadline(() => client.getConnectionStatus!(teamId), controller.signal)
        .then(status => {
          if (!controller.signal.aborted)
            setStorageContext({ teamId, kind: status.driveKind ?? null });
        })
        .catch(() => {
          /* Unknown storage stays unknown; never infer My Drive. */
        });
    }
    return () => controller.abort();
  }, [client, teamId]);
  const { t, language } = useI18n();
  const { push, toasts } = useToasts();
  useEffect(() => {
    if (!owner.current()) return;
    for (const toast of toasts) {
      const delivered = stopFeedback.current.get(toast.id);
      if (!delivered) continue;
      if (delivered.error) delivered.flow.fail(delivered.error, 'result_visible');
      else delivered.flow.complete();
      stopFeedback.current.delete(toast.id);
      stopFlows.current.delete(delivered.flow);
    }
  }, [toasts, owner]);
  const workspaceOperations = useOptionalWorkspaceOperations();
  const space = useOptionalSpaceAgentQueue();
  const [trashGroups, setTrashGroups] = useState<Set<string>>(() => new Set());
  const directTrashKeys = useRef(new Map<string, string>());
  const observedTrash = useRef('');
  const { can, permissions } = useTeam();
  const titleId = useId();
  const searchId = useId();
  const mayRun = can('process');
  // 050: the R2 option is one more icon beside the auto-update choices.
  const videoR2 = useCatalogVideoR2Team(teamId);
  const videoR2For = (catalogId: string, locked?: string) =>
    videoR2.available
      ? {
          row: videoR2.row(catalogId),
          disabledReason: !videoR2.canManage ? t('catalogVideoR2NoPermission') : locked,
          onToggle: (next: boolean) => void videoR2.toggle(catalogId, next)
        }
      : undefined;

  const updater = useCatalogUpdater(teamId, client);
  const registry = useCatalogRegistry(teamId, true, client);
  const inline = useCatalogInlineChanges({
    teamId,
    client,
    rows: registry.rows ?? [],
    reload: registry.reload,
    onChanged,
    clockOffsetMs: updater.offsetMs
  });
  const [legendOpen, setLegendOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const recentReturnTarget = useRef<{ catalogId?: string; field?: CatalogField } | null>(null);
  const [excludedRuns, setExcludedRuns] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [recencyFilter, setRecencyFilter] = useState('all');
  const [createdRange, setCreatedRange] = useState({ from: '', to: '' });
  const [sortBy, setSortBy] = useState('created');
  const [visibleCount, setVisibleCount] = useState(60);
  const [confirmDelete, setConfirmDelete] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** Rows with a change on its way, so their controls wait instead of taking a second press. */
  const [localBusyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const commands = useCatalogCommands({
    teamId,
    client,
    reloadFresh: registry.reloadFresh,
    onConfirmed: (receipt, mode) => {
      push({
        tone:
          mode !== 'request' || receipt.status === 'cancelled' || receipt.acceptedCount === 0
            ? 'info'
            : 'success',
        text:
          receipt.status === 'cancelled'
            ? t('catalogCommandCancelled')
            : mode === 'cancel'
              ? t('catalogCommandAlreadyAccepted')
              : mode === 'read'
                ? t('catalogCommandRecovered', { count: receipt.acceptedCount })
                : receipt.acceptedCount === 0
                  ? t('catalogUpdaterNoWorkAccepted')
                  : t('catalogUpdaterNowStarted', { count: receipt.acceptedCount })
      });
      updater.reload();
      onChanged?.();
    }
  });
  const busyIds = new Set([
    ...localBusyIds,
    ...commands.refreshing,
    ...commands.states.flatMap(state => state.intent.catalogIds)
  ]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState<'all' | 'restitch' | 'schedule'>('all');
  const [undoToast, setUndoToast] = useState<
    import('./useCatalogInlineChanges').CatalogUndo | null
  >(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorPending, setEditorPending] = useState(false);
  const [editorUncertain, setEditorUncertain] = useState(false);
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const inlinePending = Object.values(inline.states).some(state => state.phase === 'pending');
  const closeUncertain =
    editorUncertain || Object.values(inline.states).some(state => state.phase === 'unknown');
  const guard = (action: () => void) => {
    if (!owner.current()) return;
    if (editorPending || inlinePending) return;
    if (editorDirty || closeUncertain) setDiscardAction(() => action);
    else action();
  };

  useEffect(() => {
    const prevent = (event: Event) => {
      if (!owner.current()) return;
      if (
        editorPending ||
        inlinePending ||
        ((editorDirty || closeUncertain) &&
          !window.confirm(
            t(closeUncertain ? 'catalogUpdaterUncertainCloseBody' : 'catalogUpdaterDiscardDraft')
          ))
      )
        event.preventDefault();
    };
    window.addEventListener(BEFORE_NAVIGATION_EVENT, prevent);
    return () => window.removeEventListener(BEFORE_NAVIGATION_EVENT, prevent);
  }, [editorDirty, editorPending, closeUncertain, inlinePending, t, owner]);
  const listFlow = useRef<ReturnType<typeof beginCatalogUiFlow> | null>(null);
  useEffect(() => {
    const flow = beginCatalogUiFlow('list');
    listFlow.current = flow;
    return () => flow.cancel();
  }, []);
  useEffect(() => {
    if (registry.rows !== null) {
      listFlow.current?.stage('result_visible');
      if (registry.invalidRowCount > 0) listFlow.current?.fail('INVALID_RESPONSE');
      else listFlow.current?.complete();
    } else if (registry.error) listFlow.current?.fail('READ_FAILED');
  }, [registry.rows, registry.error, registry.invalidRowCount]);
  const [renameRow, setRenameRow] = useState<CatalogRegistryRow | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const openRename = (row: CatalogRegistryRow) => {
    setRenameRow(row);
    setRenameOpen(true);
  };
  const [expandedCatalogId, setExpandedCatalogId] = useState<string | null>(null);
  const [videoVariationsRow, setVideoVariationsRow] = useState<CatalogRegistryRow | null>(null);
  const [publicationCatalogId, setPublicationCatalogId] = useState<string | null>(null);
  const [historyCatalogId, setHistoryCatalogId] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLSpanElement>(null);

  const rows = (registry.rows ?? []).map(row => {
    const snapshot = inline.snapshotFor(row.catalogId);
    return snapshot
      ? {
          ...row,
          profile: snapshot.profile,
          updateInterval: snapshot.interval,
          nextRunAt: snapshot.nextRunAt === undefined ? row.nextRunAt : snapshot.nextRunAt
        }
      : row;
  });
  const rowsById = new Map(rows.map(row => [row.catalogId, row]));
  const nameCounts = new Map<string, number>();
  for (const row of rows) nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
  const duplicateNames = new Set(
    [...nameCounts].filter(([, count]) => count > 1).map(([name]) => name)
  );
  const heldRows = useRef(new Map<string, CatalogRegistryRow>());
  const listRef = useRef<HTMLTableElement>(null);
  useEffect(() => {
    if (!recentOpen || inline.undo.length > 0) return;
    recentReturnTarget.current ??= {};
    setRecentOpen(false);
  }, [recentOpen, inline.undo.length]);
  useEffect(() => {
    if (recentOpen || !recentReturnTarget.current) return;
    const target = recentReturnTarget.current;
    recentReturnTarget.current = null;
    const frame = requestAnimationFrame(() => {
      if (!owner.current()) return;
      const row = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>('[data-catalog-id]') ?? []
      ).find(element => element.dataset.catalogId === target.catalogId);
      const field = target.field === 'updateInterval' ? 'schedule' : target.field;
      const control = field
        ? row?.querySelector<HTMLElement>(`[data-catalog-field="${field}"]`)
        : null;
      (control ?? document.getElementById(searchId))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [recentOpen, searchId]);
  const [changeNotice, setChangeNotice] = useState('');
  const [heldRevision, setHeldRevision] = useState(0);
  const shown = useMemo(
    () =>
      filterCatalogRows(
        rows.map(row => heldRows.current.get(row.catalogId) ?? row),
        query
      )
        .filter(row => {
          if (!matchesCatalogCreatedAt(row.createdAt, createdRange)) return false;
          if (statusFilter === 'scheduled' && row.updateInterval === null) return false;
          if (statusFilter === 'off' && row.updateInterval !== null) return false;
          if (statusFilter === 'updating' && !row.updatePending) return false;
          if (statusFilter === 'failed' && !needsAttention(row)) return false;
          if (statusFilter === 'never' && lastSuccess(row) !== null) return false;
          if (recencyFilter === 'never' && lastSuccess(row) !== null) return false;
          if (
            recencyFilter === 'day' &&
            (!lastSuccess(row) || Date.now() - Date.parse(lastSuccess(row)!) > 86_400_000)
          )
            return false;
          if (
            recencyFilter === 'week' &&
            (!lastSuccess(row) || Date.now() - Date.parse(lastSuccess(row)!) > 604_800_000)
          )
            return false;
          if (
            recencyFilter === 'older' &&
            (!lastSuccess(row) || Date.now() - Date.parse(lastSuccess(row)!) <= 604_800_000)
          )
            return false;
          return true;
        })
        .sort((a, b) => {
          const field =
            sortBy === 'last' ? 'lastUpdatedAt' : sortBy === 'next' ? 'nextRunAt' : 'createdAt';
          const left = (sortBy === 'last' ? lastSuccess(a) : a[field]) ?? '';
          const right = (sortBy === 'last' ? lastSuccess(b) : b[field]) ?? '';
          return sortBy === 'next' || sortBy === 'createdAsc'
            ? left.localeCompare(right) || a.catalogId.localeCompare(b.catalogId)
            : right.localeCompare(left) || a.catalogId.localeCompare(b.catalogId);
        }),
    [rows, query, statusFilter, recencyFilter, sortBy, heldRevision, createdRange]
  );
  const filterMounted = useRef(false);
  const previousCreatedRange = useRef(createdRange);
  useEffect(() => {
    if (!filterMounted.current) {
      filterMounted.current = true;
      return;
    }
    if (registry.rows === null) return;
    const dateChanged = previousCreatedRange.current !== createdRange;
    previousCreatedRange.current = createdRange;
    const flow = beginCatalogUiFlow('filter', {
      count: shown.length,
      ...(dateChanged ? { field: 'createdAt' as const } : {})
    });
    flow.stage('result_visible');
    flow.complete();
  }, [query, statusFilter, recencyFilter, sortBy, createdRange, shown.length]);
  const liveSelected = rows.filter(row => selected.has(row.catalogId));
  const shownChosen = shown.filter(row => selected.has(row.catalogId)).length;
  useEffect(() => setVisibleCount(60), [query, statusFilter, recencyFilter, sortBy, createdRange]);
  const allShownChosen = shown.length > 0 && shownChosen === shown.length;

  useEffect(() => {
    const input = selectAllRef.current?.querySelector('input');
    if (input) input.indeterminate = shownChosen > 0 && !allShownChosen;
  }, [allShownChosen, shownChosen]);

  useEffect(() => {
    const latest = inline.undo.at(-1);
    if (!latest) {
      setUndoToast(null);
      return;
    }
    setUndoToast(latest);
    const timer = window.setTimeout(() => setUndoToast(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [inline.undo]);

  const toggle = (catalogId: string) =>
    setSelected(current => {
      const next = new Set(current);
      if (next.has(catalogId)) next.delete(catalogId);
      else next.add(catalogId);
      return next;
    });

  const toggleShown = () =>
    setSelected(current => {
      const next = new Set(current);
      for (const row of shown) {
        if (allShownChosen) next.delete(row.catalogId);
        else next.add(row.catalogId);
      }
      return next;
    });

  const busyRef = useRef(new Set<string>());
  const withBusy = async (
    ids: string[],
    work: () => Promise<void>,
    options: {
      rethrow?: boolean;
      refreshOnFailure?: boolean;
      onFailure?: (error: unknown) => void;
    } = {}
  ) => {
    if (!owner.current()) return;
    if (ids.some(id => busyRef.current.has(id))) {
      if (options.rethrow) throw new TeamApiError('WRONG_STATE', false);
      return;
    }
    ids.forEach(id => busyRef.current.add(id));
    setBusyIds(current => new Set([...current, ...ids]));
    try {
      await work();
      if (!owner.current()) return;
      updater.reload();
      registry.reload();
      onChanged?.();
    } catch (error) {
      if (owner.current()) {
        if (options.onFailure) options.onFailure(error);
        else push({ tone: 'error', text: teamErrorMessageFor(error, t) });
        if (options.refreshOnFailure) {
          updater.reload();
          registry.reload();
        }
      }
      if (options.rethrow) throw error;
    } finally {
      ids.forEach(id => busyRef.current.delete(id));
      if (owner.current())
        setBusyIds(current => new Set([...current].filter(id => !ids.includes(id))));
    }
  };

  const executeNow = (ids: string[]) => {
    if (!owner.current()) return;
    if (ids.some(id => inline.blocked(id) || commands.blocked(id) || busyRef.current.has(id)))
      return;
    if (ids.some(id => rowsById.get(id)?.profile?.reconciliationRequired)) {
      push({ tone: 'error', text: t('catalogUpdaterReconciliationHold') });
      return;
    }
    return commands.submit(ids).then(outcome => {
      if (owner.current() && outcome.kind === 'rejected')
        push({ tone: 'error', text: teamErrorMessageFor(outcome.error, t) });
    });
  };

  const updateNow = (ids: string[]) => {
    const excluded = ids.filter(
      id =>
        inline.blocked(id) ||
        busyIds.has(id) ||
        rowsById.get(id)?.profile?.reconciliationRequired ||
        rowsById.get(id)?.updatePending
    );
    if (excluded.length) {
      setExcludedRuns(ids);
      return;
    }
    return executeNow(ids);
  };

  const changeField = (
    row: CatalogRegistryRow,
    field: import('./useCatalogInlineChanges').CatalogField,
    value: import('./useCatalogInlineChanges').Value
  ) => {
    if (
      !owner.current() ||
      !mayRun ||
      inline.blocked(row.catalogId) ||
      commands.blocked(row.catalogId) ||
      busyRef.current.has(row.catalogId)
    )
      return;
    heldRows.current.set(row.catalogId, row);
    void inline.change(row.catalogId, field, value);
  };
  useEffect(() => {
    for (const [id] of heldRows.current) {
      const state = inline.states[id];
      if (!state || state.phase === 'pending') continue;
      const active = document.activeElement as HTMLElement | null;
      const focusedRow = active?.closest<HTMLElement>('[data-catalog-id]');
      const control = active?.dataset.catalogField;
      heldRows.current.delete(id);
      setHeldRevision(value => value + 1);
      // A next render uses the acknowledged profile when applying filters and sort.
      if (state.phase === 'saved') {
        setChangeNotice(t('catalogIconsSaved'));
        const before = Array.from(
          listRef.current?.querySelectorAll<HTMLElement>('[data-catalog-id]') ?? []
        );
        const position = before.findIndex(element => element.dataset.catalogId === id);
        const neighbors = [
          ...before.slice(position + 1),
          ...before.slice(0, position).reverse()
        ].map(element => element.dataset.catalogId);
        requestAnimationFrame(() => {
          const visible = Array.from(
            listRef.current?.querySelectorAll<HTMLElement>('[data-catalog-id]') ?? []
          );
          if (!visible.some(element => element.dataset.catalogId === id)) {
            setChangeNotice(t('catalogIconsHidden'));
            if (focusedRow?.dataset.catalogId === id) {
              const neighbor = neighbors
                .map(id => visible.find(element => element.dataset.catalogId === id))
                .find(Boolean);
              const target = neighbor?.querySelector<HTMLButtonElement>(
                control ? `[data-catalog-field="${control}"]` : 'button'
              );
              (target ?? document.getElementById(searchId))?.focus();
            }
          }
        });
      }
    }
  }, [inline.states, searchId, t]);
  useEffect(() => {
    for (const row of shown.slice(0, visibleCount)) inline.delivered(row.catalogId);
  });

  const showStopFeedback = (
    flow: CatalogUiFlow,
    input: Parameters<typeof push>[0],
    error?: CatalogUiFailure
  ) => {
    if (!owner.current()) {
      flow.cancel();
      return;
    }
    const toastId = push(input);
    stopFeedback.current.set(toastId, { flow, error });
  };
  const observeStop = async (
    row: CatalogRegistryRow,
    flow: CatalogUiFlow,
    controller: AbortController,
    requestFlowId: string,
    accepted = false
  ) => {
    flow.stage('stop_readback_requested');
    let inactive = false;
    let readCode: CatalogUiFailure = 'PROCESS_RESULT_UNCERTAIN';
    try {
      const fresh = await withReadDeadline(async signal => {
        if (client.listCatalogManagerSnapshot)
          return client.listCatalogManagerSnapshot(teamId, { signal });
        if (client.listTeamProductCatalogSnapshot)
          return client.listTeamProductCatalogSnapshot(teamId, { signal });
        return {
          rows: await client.listTeamProductCatalogs(teamId, { signal }),
          invalidRowCount: 0
        };
      }, controller.signal);
      if (!owner.current()) {
        flow.cancel();
        return;
      }
      const current = fresh?.rows.find(item => item.catalogId === row.catalogId);
      const observedRound = Date.parse(row.activeRoundAt ?? '');
      const currentRound = Date.parse(current?.activeRoundAt ?? '');
      if (
        current &&
        (Number.isFinite(observedRound) || row.activeRoundAt === null) &&
        (current.activeRoundAt === null ||
          (Number.isFinite(currentRound) && currentRound !== observedRound))
      ) {
        inactive = true;
        flow.stage('stop_target_inactive');
      } else if (
        Number.isFinite(observedRound) &&
        Number.isFinite(currentRound) &&
        currentRound === observedRound
      ) {
        flow.stage('stop_target_active');
      } else flow.stage('stop_readback_unknown');
    } catch (cause) {
      if (!owner.current()) {
        flow.cancel();
        return;
      }
      readCode = teamErrorCodeOf(cause) ?? 'READ_FAILED';
      flow.stage('stop_readback_unknown', readCode);
    }
    if (inactive) {
      // Our own accepted stop ended the round: that is a success, not a stale target.
      showStopFeedback(
        flow,
        accepted
          ? { tone: 'success', text: t('catalogStopDone') }
          : { tone: 'info', text: t('catalogStopObservedInactive') }
      );
      return;
    }
    showStopFeedback(
      flow,
      {
        tone: 'warning',
        text: t('catalogStopUnconfirmed'),
        action: { label: t('catalogCommandCheck'), run: () => checkStop(row, requestFlowId) }
      },
      readCode
    );
  };
  const stopFailure = (flow: CatalogUiFlow, cause: unknown) => {
    const code = teamErrorCodeOf(cause) ?? 'UNKNOWN';
    flow.stage('stop_rejected', code);
    showStopFeedback(flow, { tone: 'error', text: teamErrorMessageFor(cause, t) }, code);
  };
  const checkStop = (row: CatalogRegistryRow, requestFlowId: string) => {
    if (!owner.current() || busyRef.current.has(row.catalogId)) return;
    const flow = beginCatalogUiFlow('stop', {
      count: 1,
      relatedFlowId: row.activeAttemptId ?? undefined,
      originFlowId: requestFlowId
    });
    stopFlows.current.add(flow);
    flow.stage('stop_check_requested');
    return withBusy(
      [row.catalogId],
      async () => {
        const controller = new AbortController();
        stopControllers.current.add(controller);
        try {
          await observeStop(row, flow, controller, requestFlowId);
        } finally {
          stopControllers.current.delete(controller);
        }
      },
      { onFailure: cause => stopFailure(flow, cause) }
    );
  };
  const cancelNow = (row: CatalogRegistryRow) => {
    if (
      !owner.current() ||
      busyRef.current.has(row.catalogId) ||
      commands.blocked(row.catalogId) ||
      inline.blocked(row.catalogId)
    )
      return;
    const flow = beginCatalogUiFlow('stop', {
      count: 1,
      relatedFlowId: row.activeAttemptId ?? undefined
    });
    stopFlows.current.add(flow);
    flow.stage('stop_requested');
    return withBusy(
      [row.catalogId],
      async () => {
        if (inline.blocked(row.catalogId) || commands.blocked(row.catalogId))
          throw new TeamApiError('WRONG_STATE', false);
        if (row.activeRoundAt === undefined)
          throw new TeamApiError('CATALOG_STOP_TARGET_UNKNOWN', false);
        const controller = new AbortController();
        stopControllers.current.add(controller);
        let accepted = false;
        try {
          try {
            const cancelled =
              row.activeRoundAt === null
                ? false
                : await withCatalogCommandDeadline(signal => {
                    if (!client.cancelCatalogUpdate)
                      throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
                    return client.cancelCatalogUpdate(
                      teamId,
                      row.catalogId,
                      { roundAt: row.activeRoundAt!, attemptId: row.activeAttemptId ?? null },
                      owner.options(signal)
                    );
                  }, controller.signal);
            if (!owner.current()) {
              flow.cancel();
              return;
            }
            accepted = cancelled === true;
            flow.stage(cancelled ? 'stop_accepted' : 'stop_not_active');
          } catch (cause) {
            if (!owner.current()) {
              flow.cancel();
              return;
            }
            const code = teamErrorCodeOf(cause);
            if (
              !(cause instanceof TypeError) &&
              code !== 'TEAM_TRANSPORT_UNAVAILABLE' &&
              code !== 'PROCESS_RESULT_UNCERTAIN'
            )
              throw cause;
            flow.stage('stop_reply_unknown', code ?? 'UNKNOWN');
          }
          await observeStop(row, flow, controller, flow.id, accepted);
        } finally {
          stopControllers.current.delete(controller);
        }
      },
      { refreshOnFailure: true, onFailure: cause => stopFailure(flow, cause) }
    );
  };

  const trashRows = rows.map(row => ({
    id: row.catalogId,
    name: row.name,
    category: 'other' as const
  }));
  const managerTrash = workspaceOperations?.bulkTrash;
  const currentCatalogIds = new Set(trashRows.map(row => row.id));
  const receipts =
    managerTrash?.groups.filter(
      group =>
        group.teamId === teamId &&
        (trashGroups.has(group.id) ||
          group.items.some(item => currentCatalogIds.has(item.materialId)))
    ) ?? [];
  // The manager reports these itself, with catalog names; the Files corner leaves them.
  const claimKey = receipts.map(group => group.id).join(',');
  const claimTrash = managerTrash?.claim;
  useEffect(() => {
    if (!claimKey || !claimTrash) return;
    return claimTrash(claimKey.split(','));
  }, [claimKey, claimTrash]);
  const receiptFingerprint = receipts
    .map(
      group =>
        `${group.id}:${group.items
          .map(item => {
            const history =
              managerTrash?.historicalReceipts?.get(group.id)?.get(item.materialId) ??
              item.historicalReceipt;
            return `${item.materialId}:${item.state}:${history ? `${history.state}:${history.memberCount}:${history.matchingCount}:${history.missingCount}` : 'current'}`;
          })
          .join(',')}`
    )
    .join('|');
  useEffect(() => {
    if (!receiptFingerprint || observedTrash.current === receiptFingerprint) return;
    observedTrash.current = receiptFingerprint;
    const confirmed = new Set(
      receipts.flatMap(group =>
        group.items
          .filter(
            item =>
              item.state === 'confirmed' &&
              !managerTrash?.historicalReceipts?.get(group.id)?.has(item.materialId)
          )
          .map(item => item.materialId)
      )
    );
    if (confirmed.size)
      setSelected(current => new Set([...current].filter(id => !confirmed.has(id))));
    registry.reload();
    onChanged?.();
  }, [receiptFingerprint, registry.reload, onChanged]);
  const deleteSelected = async () => {
    const ids = confirmDelete;
    await withBusy(ids, async () => {
      if (managerTrash) {
        const group = await managerTrash.start(
          trashRows.filter(row => ids.includes(row.id)),
          teamApi
        );
        if (!owner.current()) return;
        setTrashGroups(current => new Set([...current, group.id]));
        setConfirmDelete([]);
        return;
      }
      try {
        for (const materialId of ids) {
          if (!owner.current()) return;
          const idempotencyKey = directTrashKeys.current.get(materialId) ?? crypto.randomUUID();
          directTrashKeys.current.set(materialId, idempotencyKey);
          const result = await teamApi.trashMaterial({ teamId, materialId, idempotencyKey });
          if (!owner.current()) return;
          if (result.state !== 'succeeded')
            throw new TeamApiError('PROCESS_RESULT_UNCERTAIN', true);
          if (result.materialId !== null && result.materialId !== materialId)
            throw new TeamApiError('INVALID_RESPONSE', false);
          directTrashKeys.current.delete(materialId);
          setSelected(current => new Set([...current].filter(id => id !== materialId)));
        }
        setConfirmDelete([]);
      } finally {
        if (owner.current()) {
          registry.reload();
          onChanged?.();
        }
      }
    });
  };

  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }),
    [language]
  );
  const when = (iso: string) =>
    `${dateFormat.format(new Date(iso))} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;

  const createdDateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
    [language]
  );
  const shortWhen = (iso: string) =>
    new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-GB', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso));
  const nameParts = (name: string) => {
    const match = /^(.*?)(_v\d+.*)$/i.exec(name);
    return match
      ? [match[1], match[2]]
      : name.length > 42
        ? [name.slice(0, -16), name.slice(-16)]
        : [name, ''];
  };

  const status = (
    <p className="team-updater-status">
      {registry.rows === null
        ? t(registry.error ? 'catalogUpdaterUnavailable' : 'catalogUpdaterLoading')
        : t('catalogUpdaterListSummary', {
            count: rows.length,
            scheduled: rows.filter(row => row.updateInterval !== null).length,
            attention: rows.filter(needsAttention).length
          })}
    </p>
  );

  const trashPanels = managerTrash
    ? receipts.map(group => (
        <BulkTrashPanel
          key={group.id}
          group={group}
          historicalReceipts={managerTrash.historicalReceipts?.get(group.id)}
          rows={trashRows}
          names={managerTrash.names}
          executing={managerTrash.executing?.has(group.id)}
          uncertain={managerTrash.uncertain}
          onVisible={managerTrash.acknowledgeVisible}
          onDismiss={managerTrash.dismiss}
          onRetry={
            permissions?.delete && managerTrash.owns(group)
              ? () => {
                  void managerTrash
                    .retry(group, trashRows, teamApi)
                    .then(() => registry.reload())
                    .catch(error => push({ tone: 'error', text: teamErrorMessageFor(error, t) }));
                }
              : undefined
          }
        />
      ))
    : null;

  return (
    <Modal
      bare
      labelledBy={titleId}
      onClose={() => guard(onClose)}
      backdropClassName="team-updater-backdrop"
      className="team-updater-dialog catalog-manager-dialog"
      initialFocus={`[id="${searchId}"]`}
    >
      <header className="team-updater-header">
        <div>
          <h2 id={titleId}>{t('catalogUpdaterTitle')}</h2>
          {status}
          {rows.some(needsAttention) && (
            <Button
              className="catalog-attention-filter"
              size="sm"
              variant="ghost"
              onClick={() => setStatusFilter('failed')}
            >
              {t('catalogUpdaterFilterFailed')} ({rows.filter(needsAttention).length})
            </Button>
          )}
        </div>
        <IconButton
          ref={menuAnchor}
          variant="ghost"
          label={t('catalogUpdaterMore')}
          onClick={() => setMenuOpen(true)}
        >
          <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        <DropdownMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchor={menuAnchor}
          label={t('catalogUpdaterMore')}
          items={[
            {
              id: 'defaults',
              label: t('catalogUpdaterDefaultsTitle'),
              onSelect: () =>
                guard(() => {
                  navigateTo(spaceRouteFor(teamId, { kind: 'settings', tab: 'product-catalog' }));
                })
            },
            ...(liveSelected.length > 0 && can('delete')
              ? [
                  {
                    id: 'delete',
                    label: t('catalogUpdaterDeleteSelected'),
                    destructive: true,
                    onSelect: () => setConfirmDelete(liveSelected.map(row => row.catalogId))
                  }
                ]
              : [])
          ]}
        />
        <IconButton
          variant="ghost"
          title=""
          label={t('catalogUpdaterClose')}
          onClick={() => guard(onClose)}
        >
          <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      </header>

      {notice}

      <div className="team-updater-toolbar">
        <label className="team-task-picker-search team-updater-search" htmlFor={searchId}>
          <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder={t('catalogUpdaterSearch')}
            aria-label={t('catalogUpdaterSearch')}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              searchFieldEscape(
                query,
                () => setQuery(''),
                () => guard(onClose)
              )(event);
              if (event.key === 'Escape') event.stopPropagation();
            }}
          />
          {query && (
            <button
              type="button"
              className="team-task-picker-search-clear"
              aria-label={t('catalogUpdaterClearSearch')}
              onClick={() => setQuery('')}
            >
              <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          )}
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(value => !value)}
        >
          <SlidersHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('catalogUpdaterFilters')}
          {[statusFilter, recencyFilter].filter(value => value !== 'all').length > 0 &&
            ` (${[statusFilter, recencyFilter].filter(value => value !== 'all').length})`}
        </Button>
        <CatalogCreatedFilter value={createdRange} onChange={setCreatedRange} />
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={legendOpen}
          onClick={() => {
            setLegendOpen(value => !value);
            localStorage.setItem('catalog-icon-legend-seen', '1');
          }}
        >
          <CircleHelp size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('catalogIconsHelp')}
        </Button>
        <Button
          className="catalog-recent-trigger"
          size="sm"
          variant="ghost"
          disabled={inline.undo.length === 0}
          onClick={() => setRecentOpen(true)}
        >
          <History size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('catalogIconsRecent')}{' '}
          <span className="catalog-recent-count">({inline.undo.length})</span>
        </Button>
        {mayRun && (
          <span ref={selectAllRef} className="team-updater-select-all">
            <Checkbox
              checked={allShownChosen}
              disabled={shown.length === 0}
              onChange={toggleShown}
              label={t('catalogUpdaterSelectAll')}
            />
          </span>
        )}
      </div>

      {legendOpen && (
        <Modal
          nested
          labelledBy={`${titleId}-icon-help`}
          onClose={() => setLegendOpen(false)}
          size="md"
          className="catalog-icon-help"
          closeLabel={t('catalogUpdaterClose')}
        >
          <h2 id={`${titleId}-icon-help`}>{t('catalogIconsHelp')}</h2>
          <CatalogIconLegend
            teamId={teamId}
            videoR2={videoR2.available}
            onOpenSettings={href =>
              guard(() => {
                setLegendOpen(false);
                setExpandedCatalogId(null);
                navigateTo(href);
              })
            }
          />
        </Modal>
      )}
      <span className="sr-only" role="status">
        {changeNotice}
      </span>
      {filtersOpen && (
        <div className="team-updater-filters" role="group" aria-label={t('catalogUpdaterFilters')}>
          <div className="team-updater-filter-field">
            <span id="catalog-recency-filter-label">{t('catalogUpdaterFilterRecency')}</span>
            <SelectMenu
              id="catalog-recency-filter"
              label={t('catalogUpdaterFilterRecency')}
              placeholder={t('catalogUpdaterFilterAll')}
              errorLabel={t('catalogUpdaterFilterRecency')}
              value={recencyFilter}
              options={[
                { value: 'all', label: t('catalogUpdaterFilterAll') },
                { value: 'day', label: t('catalogUpdaterFilterDay') },
                { value: 'week', label: t('catalogUpdaterFilterWeek') },
                { value: 'older', label: t('catalogUpdaterFilterOlder') },
                { value: 'never', label: t('catalogUpdaterNeverUpdated') }
              ]}
              onChange={setRecencyFilter}
            />
          </div>
          <div className="team-updater-filter-field">
            <span id="catalog-sort-label">{t('catalogUpdaterSort')}</span>
            <SelectMenu
              id="catalog-sort"
              label={t('catalogUpdaterSort')}
              placeholder={t('catalogUpdaterSort')}
              errorLabel={t('catalogUpdaterSort')}
              value={sortBy}
              options={[
                { value: 'created', label: t('catalogUpdaterSortCreated') },
                { value: 'createdAsc', label: t('catalogCreatedOldest') },
                { value: 'last', label: t('catalogUpdaterSortLast') },
                { value: 'next', label: t('catalogUpdaterSortNext') }
              ]}
              onChange={setSortBy}
            />
          </div>
        </div>
      )}
      {[statusFilter, recencyFilter].some(value => value !== 'all') || sortBy !== 'created' ? (
        <div className="team-updater-active-filters">
          <span>
            {[
              statusFilter !== 'all' &&
                `${t('catalogUpdaterFilterStatus')}: ${statusFilter === 'scheduled' ? t('catalogUpdaterFilterScheduled') : statusFilter === 'off' ? t('catalogUpdaterOff') : statusFilter === 'updating' ? t('catalogUpdaterUpdatingNow') : statusFilter === 'failed' ? t('catalogUpdaterFilterFailed') : t('catalogUpdaterNeverUpdated')}`,
              recencyFilter !== 'all' &&
                `${t('catalogUpdaterFilterRecency')}: ${t(recencyFilter === 'day' ? 'catalogUpdaterFilterDay' : recencyFilter === 'week' ? 'catalogUpdaterFilterWeek' : recencyFilter === 'older' ? 'catalogUpdaterFilterOlder' : 'catalogUpdaterNeverUpdated')}`,
              sortBy !== 'created' &&
                t(
                  sortBy === 'last'
                    ? 'catalogUpdaterSortLast'
                    : sortBy === 'createdAsc'
                      ? 'catalogCreatedOldest'
                      : 'catalogUpdaterSortNext'
                )
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setStatusFilter('all');
              setRecencyFilter('all');
              setCreatedRange({ from: '', to: '' });
              setSortBy('created');
            }}
          >
            {t('catalogUpdaterClearFilters')}
          </Button>
        </div>
      ) : null}
      {Boolean(commands.error) && (
        <p className="team-inline-error" role="alert">
          {teamErrorMessageFor(commands.error, t)}
        </p>
      )}
      {commands.states.map(state => {
        const captionId = `${titleId}-command-${state.intent.commandId}`;
        const names = state.intent.catalogIds
          .slice(0, 3)
          .flatMap(id => {
            const row = rowsById.get(id);
            return row ? [row.name] : [];
          })
          .join(', ');
        const code = teamErrorCodeOf(state.error);
        const recover = async (kind: 'check' | 'cancel') => {
          const outcome = await (kind === 'check'
            ? commands.check(state.intent.commandId)
            : commands.cancel(state.intent.commandId));
          if (owner.current() && outcome?.kind === 'rejected')
            push({ tone: 'error', text: teamErrorMessageFor(outcome.error, t) });
        };
        return (
          <div key={state.intent.commandId} className="team-inline-error" role="status">
            <p id={captionId}>
              {t(state.phase === 'working' ? 'catalogCommandChecking' : 'catalogCommandUnknown', {
                count: state.intent.catalogIds.length
              })}
              {names && (
                <>
                  {' '}
                  {names}
                  {state.intent.catalogIds.length > 3
                    ? ` ${t('catalogCommandMore', { count: state.intent.catalogIds.length - 3 })}`
                    : ''}
                </>
              )}
            </p>
            {state.phase === 'unknown' && code && code !== 'PROCESS_RESULT_UNCERTAIN' && (
              <p className="field-hint">
                {t('catalogCommandLastProblem', { message: teamErrorMessageFor(state.error, t) })}
              </p>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-describedby={captionId}
              disabled={state.phase === 'working'}
              onClick={() => void recover('check')}
            >
              {t('catalogCommandCheck')}
            </Button>
            {mayRun && (
              <Button
                size="sm"
                variant="ghost"
                aria-describedby={captionId}
                disabled={state.phase === 'working'}
                onClick={() => void recover('cancel')}
              >
                {t('catalogCommandCancel')}
              </Button>
            )}
          </div>
        );
      })}
      {commands.refreshing.length > 0 && (
        <div className="team-inline-error" role="status">
          <p>{t('catalogCommandRefresh')}</p>
          <Button size="sm" variant="ghost" onClick={() => void commands.refresh()}>
            {t('catalogCommandCheck')}
          </Button>
        </div>
      )}
      {registry.error && registry.rows !== null && (
        <div className="team-inline-error" role="alert">
          {t('catalogUpdaterStale', {
            date: registry.lastLoadedAt
              ? when(registry.lastLoadedAt)
              : t('catalogUpdaterUnknownTime')
          })}{' '}
          <Button type="button" size="sm" variant="ghost" onClick={registry.reload}>
            {t('catalogUpdaterRetry')}
          </Button>
        </div>
      )}
      {registry.invalidRowCount > 0 && (
        <div className="team-inline-error" role="alert">
          {t('catalogUpdaterPartialRead', { count: registry.invalidRowCount })}
          <Button type="button" size="sm" variant="ghost" onClick={registry.reload}>
            {t('catalogUpdaterRetry')}
          </Button>
        </div>
      )}
      <div className="team-updater-list">
        {registry.rows === null && !registry.error && (
          <p className="team-updater-empty">{t('catalogUpdaterLoading')}</p>
        )}
        {registry.error && registry.rows === null && (
          <div className="team-inline-error" role="alert">
            {t('catalogUpdaterLoadFailed')}{' '}
            <Button type="button" size="sm" variant="ghost" onClick={registry.reload}>
              {t('catalogUpdaterRetry')}
            </Button>
          </div>
        )}
        {registry.rows !== null && rows.length === 0 && registry.invalidRowCount === 0 && (
          <div className="team-updater-empty">
            <p>{t('catalogUpdaterEmpty')}</p>
            <Button variant="secondary" onClick={() => guard(onClose)}>
              {t('catalogUpdaterBrowseFiles')}
            </Button>
          </div>
        )}
        {rows.length > 0 && shown.length === 0 && (
          <div className="team-updater-empty">
            <p>{t('catalogUpdaterNoMatches')}</p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setQuery('');
                setStatusFilter('all');
                setRecencyFilter('all');
                setCreatedRange({ from: '', to: '' });
              }}
            >
              {t('catalogUpdaterClearFilters')}
            </Button>
          </div>
        )}
        {shown.length > 0 && (
          <table
            className="catalog-compact-table"
            ref={listRef}
            onKeyDown={event => {
              if (
                !event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                !['ArrowUp', 'ArrowDown'].includes(event.key)
              )
                return;
              const target = event.target as HTMLElement;
              const field = target.dataset.catalogField;
              if (!field) return;
              const row = target.closest('tr');
              const neighbor =
                event.key === 'ArrowDown' ? row?.nextElementSibling : row?.previousElementSibling;
              const next = neighbor?.querySelector<HTMLButtonElement>(
                `[data-catalog-field="${field}"]`
              );
              if (next) {
                event.preventDefault();
                next.focus();
              }
            }}
          >
            <thead>
              <tr>
                <th aria-label={t('catalogUpdaterSelectAll')} />
                <th>
                  <div className="catalog-name-heading">
                    <span>{t('catalogIconsCatalog')}</span>
                    <span>{t('catalogCreatedFilter')}</span>
                  </div>
                </th>
                <th>
                  <span className="catalog-video-heading">{t('catalogIconsVideo')}</span>
                  {t('catalogIconsChanges')}
                </th>
                <th>{t('catalogIconsSchedule')}</th>
                <th>{t('catalogIconsLastSuccess')}</th>
                <th>{t('catalogIconsActions')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, visibleCount).map(filteredRow => {
                const row = rowsById.get(filteredRow.catalogId) ?? filteredRow;
                const busy = busyIds.has(row.catalogId) || inline.blocked(row.catalogId);
                const successfulAt = lastSuccess(row);
                const result = row.profile?.lastResult;
                const requiresReview = row.lastUpdateError === 'CATALOG_ATTEMPT_STATE_INCONSISTENT';
                const lastLabel = successfulAt
                  ? shortWhen(successfulAt)
                  : row.profile?.lastSuccessfulAt === null && row.profile?.lastResult
                    ? t('catalogUpdaterNoSuccessfulUpdate')
                    : row.updateCount > 0
                      ? t('catalogUpdaterUnknownTime')
                      : t('catalogUpdaterNeverUpdated');
                const state = inline.states[row.catalogId];
                const next = row.nextRunAt
                  ? Date.parse(row.nextRunAt) <= Date.now() + updater.offsetMs
                    ? t('catalogIconsWaiting')
                    : shortWhen(row.nextRunAt)
                  : t('catalogIconsNextUnknown');
                const disabledReason = !mayRun
                  ? t('catalogIconsReadOnly')
                  : busy
                    ? t('catalogIconsPendingRun')
                    : editorPending
                      ? t('catalogIconsPendingRun')
                      : undefined;
                return (
                  <CatalogProgressRow
                    row={row}
                    key={row.catalogId}
                    data-catalog-id={row.catalogId}
                    onClick={event => {
                      if (!mayRun || !(event.target instanceof Element)) return;
                      if (!event.currentTarget.contains(event.target)) return;
                      if (
                        event.target.closest(
                          'button, a, input, label, select, textarea, [role="button"], [role="checkbox"], [contenteditable="true"]'
                        )
                      )
                        return;
                      toggle(row.catalogId);
                    }}
                    className={selected.has(row.catalogId) ? 'is-selected' : undefined}
                  >
                    <td>
                      {mayRun && (
                        <label className="team-explorer-check catalog-selection-check">
                          <input
                            type="checkbox"
                            checked={selected.has(row.catalogId)}
                            aria-label={t('catalogUpdaterSelectFor', { name: row.name })}
                            onChange={() => toggle(row.catalogId)}
                          />
                          <span />
                        </label>
                      )}
                    </td>
                    <td className="catalog-name-cell">
                      <div className="catalog-name-line">
                        <span className="catalog-name-primary">
                          <CatalogIdentity
                            name={row.name}
                            previousNames={row.nameAliases}
                            parts={nameParts(row.name)}
                            context={`${row.videoName} · ${row.folderName ?? t('catalogUpdaterSpaceRoot')}`}
                            sheetUrl={row.sheetUrl}
                            onConfigure={() => setExpandedCatalogId(row.catalogId)}
                            onRename={permissions?.edit ? () => openRename(row) : undefined}
                          />
                          <span
                            className="catalog-save-indicator"
                            role="status"
                            data-phase={state?.phase}
                            aria-label={
                              state?.phase === 'pending'
                                ? t('catalogIconsSaving')
                                : state?.phase === 'saved'
                                  ? t('catalogIconsSaved')
                                  : undefined
                            }
                            title={
                              state?.phase === 'pending'
                                ? t('catalogIconsSaving')
                                : state?.phase === 'saved'
                                  ? t('catalogIconsSaved')
                                  : undefined
                            }
                          >
                            {state?.phase === 'pending' ? (
                              <LoaderCircle
                                size={16}
                                strokeWidth={ICON_STROKE}
                                className="is-spinning"
                                aria-hidden="true"
                              />
                            ) : state?.phase === 'saved' ? (
                              <Check size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                            ) : null}
                          </span>
                        </span>
                        {Number.isFinite(Date.parse(row.createdAt)) ? (
                          <time
                            className="catalog-created-at"
                            dateTime={row.createdAt}
                            aria-label={t('catalogCreatedOn', { date: when(row.createdAt) })}
                            title={t('catalogCreatedOn', { date: when(row.createdAt) })}
                          >
                            {createdDateFormat.format(new Date(row.createdAt))}
                          </time>
                        ) : (
                          <span
                            className="catalog-created-at"
                            title={t('catalogUpdaterUnknownTime')}
                          >
                            —
                          </span>
                        )}
                      </div>
                      {duplicateNames.has(row.name) && (
                        <small
                          title={`${row.videoName} · ${row.folderName ?? t('catalogUpdaterSpaceRoot')} · ${row.catalogId}`}
                        >
                          {row.folderName ?? row.videoName} · {row.catalogId.slice(-6)}
                        </small>
                      )}
                      {row.videoGeneration &&
                        ['accepted', 'preparing', 'cancel_requested', 'unknown'].includes(
                          row.videoGeneration.state
                        ) && (
                          <small role="status">
                            {t('catalogVideoCreationProgress', {
                              ready: row.videoGeneration.registeredCount,
                              total: row.videoGeneration.requestedCount
                            })}
                            {row.videoGeneration.state === 'unknown'
                              ? ` · ${t('catalogUpdaterVideoUnknownStop')}`
                              : row.videoGeneration.state === 'cancel_requested'
                                ? ` · ${t('catalogVideoCreationCanceling')}`
                                : row.videoGeneration.waitReason === 'AGENT_REQUIRED'
                                  ? ` · ${t('catalogVideoCreationWaitingAgent')}`
                                  : row.videoGeneration.waitReason
                                    ? ` · ${teamErrorMessage(row.videoGeneration.waitReason, t)}`
                                    : ''}
                            {row.videoGeneration.state === 'accepted' &&
                              row.videoGeneration.backgroundStalled && (
                                <CatalogBackgroundStalledNote
                                  teamId={teamId}
                                  onRetried={() => registry.reload()}
                                />
                              )}
                          </small>
                        )}
                      {row.videoPublication && (
                        <CatalogRowPublicationNote publication={row.videoPublication} />
                      )}
                      <span
                        // The running stage is shown, not only announced: with it hidden the row
                        // said only «Готово відео: 0 з 1» while the round stitched (1.4.3).
                        className="catalog-row-feedback"
                        role="status"
                      >
                        {requiresReview ? (
                          <button
                            type="button"
                            className="catalog-outcome-details"
                            title={teamErrorMessageFor({ code: row.lastUpdateError }, t)}
                            onClick={() => setHistoryCatalogId(row.catalogId)}
                          >
                            {t('catalogRunNeedsReview')}
                          </button>
                        ) : row.updatePending &&
                          !row.profile?.reconciliationRequired &&
                          needsVideo(row) &&
                          row.profile?.restitchStatus === 'blocked' &&
                          row.profile?.restitchBlockedCode ? (
                          <button
                            type="button"
                            className="catalog-outcome-details"
                            onClick={() => setExpandedCatalogId(row.catalogId)}
                          >
                            {t('catalogRunVideoRetryWaiting')}
                          </button>
                        ) : (row.updatePending && !row.profile?.reconciliationRequired) ||
                          (row.profile?.reconciliationRequired &&
                            row.profile.lastResult === 'running') ? (
                          // One stage, one place: the delivery check that follows the
                          // round goes through the same forward-only stage, so the row
                          // no longer steps back from «Зберігаємо…» to «Перевіряємо
                          // таблицю…» seconds before success (1.4.3 QA).
                          <CatalogRowStage
                            row={row}
                            fallback={
                              row.profile?.reconciliationRequired
                                ? 'catalogUpdaterStageVerifying'
                                : needsVideo(row) && row.profile?.restitchStatus !== 'ready'
                                  ? row.profile?.restitchStatus === 'preparing'
                                    ? 'catalogRunPreparingVideo'
                                    : 'catalogRunVideoWaiting'
                                  : 'catalogUpdaterUpdatingNow'
                            }
                          />
                        ) : row.profile?.reconciliationRequired ? (
                          <button
                            type="button"
                            className={`catalog-outcome-details${row.profile.lastResult === 'running' ? ' catalog-verifying-details' : ''}`}
                            title={t(
                              row.profile.lastResult === 'running'
                                ? 'catalogDeliveryCheckingHint'
                                : 'catalogDeliveryUncertainHint'
                            )}
                            onClick={() => setHistoryCatalogId(row.catalogId)}
                          >
                            {t(
                              row.profile.lastResult === 'running'
                                ? 'catalogRunVerifying'
                                : 'catalogDeliveryUncertain'
                            )}
                          </button>
                        ) : row.lastUpdateError ||
                          ['failed', 'partial', 'unknown'].includes(
                            row.profile?.lastResult ?? ''
                          ) ? (
                          <button
                            type="button"
                            className="catalog-outcome-details"
                            onClick={() => setHistoryCatalogId(row.catalogId)}
                          >
                            {t(
                              row.profile?.lastResult === 'partial'
                                ? 'catalogRunPartial'
                                : row.profile?.lastResult === 'unknown'
                                  ? 'catalogRunUnknown'
                                  : 'catalogRunFailed'
                            )}
                          </button>
                        ) : needsVideo(row) && row.profile?.restitchStatus === 'blocked' ? (
                          <button
                            type="button"
                            className="catalog-outcome-details"
                            onClick={() => setExpandedCatalogId(row.catalogId)}
                          >
                            {t('catalogRunNextVideoFailed')}
                          </button>
                        ) : null}
                      </span>
                      {state && ['error', 'conflict', 'unknown'].includes(state.phase) && (
                        <div className="catalog-row-error" role="alert">
                          {state.phase === 'unknown'
                            ? t('catalogIconsUnknown')
                            : state.phase === 'conflict'
                              ? t('catalogIconsConflict')
                              : teamErrorMessageFor({ code: state.code }, t)}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              state.phase === 'unknown'
                                ? void inline.reconcile(row.catalogId)
                                : changeField(row, state.field, state.intended)
                            }
                          >
                            {t(
                              state.phase === 'unknown'
                                ? 'catalogIconsCheck'
                                : 'catalogIconsRetryIntent'
                            )}
                          </Button>
                        </div>
                      )}
                    </td>
                    <td>
                      {row.profile ? (
                        <CatalogIconControls
                          profile={row.profile}
                          restitchProgress={row.restitchProgress}
                          updatePending={row.updatePending}
                          restitching={row.updatePending && row.updateStage === 'restitching'}
                          name={row.name}
                          state={state}
                          disabledReason={disabledReason}
                          onChange={(field, value) => changeField(row, field, value)}
                          onReadiness={() => setExpandedCatalogId(row.catalogId)}
                          videoR2={videoR2For(row.catalogId)}
                        />
                      ) : (
                        <small>{t('catalogUpdaterProfileUnknown')}</small>
                      )}
                    </td>
                    <td className="catalog-schedule-cell">
                      <UpdaterIntervalPicker
                        clockOffsetMs={updater.offsetMs}
                        value={row.updateInterval}
                        label={t('catalogUpdaterIntervalFor', { name: row.name })}
                        disabled={
                          Boolean(disabledReason) ||
                          !row.profile ||
                          !client.patchCatalogUpdateProfile
                        }
                        nextLabel={row.updateInterval ? next : undefined}
                        nextTitle={row.nextRunAt ? when(row.nextRunAt) : undefined}
                        schedule={row.profile?.schedule}
                        nextRunAt={row.nextRunAt}
                        onSaveSchedule={async (interval, schedule) => {
                          if (!mayRun) throw new TeamApiError('PERMISSION_DENIED', false);
                          if (busyRef.current.has(row.catalogId))
                            throw new TeamApiError('WRONG_STATE', false);
                          await inline.saveSchedule(row.catalogId, { interval, schedule });
                        }}
                        onChange={value => changeField(row, 'updateInterval', value)}
                      />
                    </td>
                    <td className="catalog-last-cell">
                      <button
                        type="button"
                        className="catalog-date-button"
                        title={successfulAt ? when(successfulAt) : undefined}
                        onClick={() => setHistoryCatalogId(row.catalogId)}
                        aria-label={`${t('catalogIconsLastSuccess')}: ${row.name} · ${successfulAt ? when(successfulAt) : lastLabel}${result ? ` · ${t(`catalogUpdaterResult_${result}`)}` : ''}`}
                      >
                        {lastLabel}
                      </button>
                    </td>
                    <td>
                      <div className="catalog-row-actions">
                        {mayRun && (
                          <IconButton
                            // Run and stop are different buttons: a native tooltip already on
                            // screen would go on saying "Stop this update" over the run button.
                            key={
                              row.updatePending && !row.profile?.reconciliationRequired
                                ? 'stop'
                                : 'run'
                            }
                            color={
                              row.updatePending && !row.profile?.reconciliationRequired
                                ? 'error'
                                : 'success'
                            }
                            variant="soft"
                            data-setting-save={
                              state?.phase === 'pending' &&
                              !busyIds.has(row.catalogId) &&
                              !editorPending &&
                              !row.profile?.reconciliationRequired
                                ? 'true'
                                : undefined
                            }
                            label={t(
                              row.updatePending && !row.profile?.reconciliationRequired
                                ? 'catalogUpdaterCancelUpdate'
                                : 'catalogUpdaterNowFor',
                              { name: row.name }
                            )}
                            disabled={
                              busy ||
                              editorPending ||
                              Boolean(row.profile?.reconciliationRequired) ||
                              (row.updatePending && !client.cancelCatalogUpdate)
                            }
                            onClick={() =>
                              row.updatePending
                                ? void cancelNow(row)
                                : void updateNow([row.catalogId])
                            }
                          >
                            {row.updatePending && !row.profile?.reconciliationRequired ? (
                              <Square
                                size={ICON_SIZE}
                                strokeWidth={ICON_STROKE}
                                aria-hidden="true"
                              />
                            ) : (
                              <RefreshCw
                                size={ICON_SIZE}
                                strokeWidth={ICON_STROKE}
                                aria-hidden="true"
                              />
                            )}
                          </IconButton>
                        )}
                        {permissions && (
                          <UpdaterRowActions
                            storageKind={
                              storageContext?.teamId === teamId ? storageContext.kind : null
                            }
                            row={row}
                            teamId={teamId}
                            permissions={permissions}
                            onVideoVariations={
                              mayRun ? () => setVideoVariationsRow(row) : undefined
                            }
                            onPublication={
                              mayRun ? () => setPublicationCatalogId(row.catalogId) : undefined
                            }
                            onChanged={registry.reload}
                            onRename={permissions.edit ? () => openRename(row) : undefined}
                            onReveal={onReveal}
                            onConfigure={
                              row.profile ? () => setExpandedCatalogId(row.catalogId) : undefined
                            }
                            onHistory={
                              client.listCatalogUpdateAttempts
                                ? () => setHistoryCatalogId(row.catalogId)
                                : undefined
                            }
                          />
                        )}
                      </div>
                    </td>
                  </CatalogProgressRow>
                );
              })}
            </tbody>
          </table>
        )}
        {shown.length > visibleCount && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setVisibleCount(count => count + 60)}
          >
            {t('catalogUpdaterShowMore', { count: shown.length - visibleCount })}
          </Button>
        )}
      </div>

      {renameRow && (
        <LazyCatalogRenameDialog
          teamId={teamId}
          materialId={renameRow.catalogId}
          currentName={renameRow.name}
          open={renameOpen}
          disabled={!permissions?.edit}
          surface="catalog_manager"
          onClose={() => setRenameOpen(false)}
          onRenamed={name => {
            setRenameRow(row => (row ? { ...row, name } : row));
            registry.reload();
          }}
        />
      )}
      {liveSelected.length > 0 && (
        <footer
          className="team-updater-footer"
          role="group"
          aria-label={t('catalogUpdaterBulkLabel')}
        >
          <span aria-live="polite">
            {t(catalogSelectedCountKey(language, liveSelected.length), {
              count: liveSelected.length
            })}
            {liveSelected.length > shownChosen &&
              ` · ${t('catalogUpdaterHiddenSelected', { count: liveSelected.length - shownChosen })}`}
          </span>
          {mayRun && (
            <div className="team-updater-bulk">
              {client.patchCatalogUpdateProfile && liveSelected.every(row => row.profile) && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={inline.hasPending}
                    onClick={() => {
                      setBulkMode('restitch');
                      setBulkOpen(true);
                    }}
                  >
                    {t('catalogUpdaterRestitch')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={inline.hasPending}
                    onClick={() => {
                      setBulkMode('schedule');
                      setBulkOpen(true);
                    }}
                  >
                    {t('catalogIconsSchedule')}
                  </Button>
                </>
              )}
              {client.patchCatalogUpdateProfile && liveSelected.every(row => row.profile) && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={inline.hasPending}
                  onClick={() => {
                    setBulkMode('all');
                    setBulkOpen(true);
                  }}
                >
                  {t('catalogUpdaterConfigure')}
                </Button>
              )}
              <Button
                size="sm"
                color="success"
                variant="soft"
                onClick={() => void updateNow(liveSelected.map(row => row.catalogId))}
              >
                {t('catalogUpdaterNow')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                {t('catalogUpdaterClearSelection')}
              </Button>
            </div>
          )}
        </footer>
      )}
      {rows
        .filter(row => row.catalogId === expandedCatalogId || row.catalogId === historyCatalogId)
        .map(row => (
          <div key={row.catalogId}>
            {expandedCatalogId === row.catalogId &&
              row.profile &&
              client.patchCatalogUpdateProfile && (
                <Modal
                  nested
                  labelledBy={`${titleId}-profile`}
                  onClose={() =>
                    guard(() => {
                      setExpandedCatalogId(null);
                      setEditorDirty(false);
                    })
                  }
                  className="team-updater-detail"
                  backdropClassName="team-updater-detail-backdrop"
                  size="lg"
                >
                  <h2 id={`${titleId}-profile`}>{row.name}</h2>
                  <div className="team-updater-profile">
                    {row.updatePending && (
                      <div>
                        <p role="status">{t('catalogUpdaterProfileActiveAttempt')}</p>
                        <CatalogUpdateProgress
                          stage={row.updateStage}
                          restitchProgress={row.restitchProgress}
                          restitchStage={row.restitchStage}
                        />
                      </div>
                    )}
                    <strong>{t('catalogUpdaterWhen')}</strong>
                    <UpdaterIntervalPicker
                      clockOffsetMs={updater.offsetMs}
                      value={row.updateInterval}
                      label={t('catalogUpdaterIntervalFor', { name: row.name })}
                      disabled={!mayRun || inline.blocked(row.catalogId) || editorPending}
                      nextLabel={
                        row.updateInterval
                          ? row.nextRunAt
                            ? Date.parse(row.nextRunAt) <= Date.now() + updater.offsetMs
                              ? t('catalogIconsWaiting')
                              : shortWhen(row.nextRunAt)
                            : t('catalogIconsNextUnknown')
                          : undefined
                      }
                      nextTitle={row.nextRunAt ? when(row.nextRunAt) : undefined}
                      schedule={row.profile?.schedule}
                      nextRunAt={row.nextRunAt}
                      onSaveSchedule={async (interval, schedule) => {
                        if (!mayRun) throw new TeamApiError('PERMISSION_DENIED', false);
                        if (busyRef.current.has(row.catalogId))
                          throw new TeamApiError('WRONG_STATE', false);
                        await inline.saveSchedule(row.catalogId, { interval, schedule });
                      }}
                      onChange={value => changeField(row, 'updateInterval', value)}
                    />
                    <strong>{t('catalogUpdaterWhat')}</strong>
                    {!mayRun && <p>{t('catalogIconsReadOnly')}</p>}
                    <CatalogIconControls
                      profile={row.profile}
                      restitchProgress={row.restitchProgress}
                      updatePending={row.updatePending}
                      restitching={row.updatePending && row.updateStage === 'restitching'}
                      name={row.name}
                      state={inline.states[row.catalogId]}
                      disabledReason={
                        !mayRun
                          ? t('catalogIconsReadOnly')
                          : inline.blocked(row.catalogId) || editorPending
                            ? t('catalogIconsPendingRun')
                            : undefined
                      }
                      onChange={(field, value) => changeField(row, field, value)}
                      onReadiness={registry.reload}
                      videoR2={videoR2For(row.catalogId)}
                    />
                    {videoR2.available && videoR2.row(row.catalogId).enabled && (
                      <p className="team-inline-note" data-testid="catalog-video-r2-status">
                        {catalogVideoR2Sentence(videoR2.row(row.catalogId), t)}
                      </p>
                    )}
                    <CatalogProfileVideoCount
                      value={row.profile.videoVariantCount ?? 1}
                      productCount={row.productCount}
                      disabled={!mayRun || inline.blocked(row.catalogId) || editorPending}
                      onSave={async value => {
                        if (!mayRun) throw new TeamApiError('PERMISSION_DENIED', false);
                        if (busyRef.current.has(row.catalogId) || inline.blocked(row.catalogId))
                          throw new TeamApiError('WRONG_STATE', false);
                        const confirmed = await inline.change(
                          row.catalogId,
                          'videoVariantCount',
                          value
                        );
                        if (!confirmed) throw new TeamApiError('PROCESS_RESULT_UNCERTAIN', true);
                      }}
                    />
                    <CatalogIconLegend
                      teamId={teamId}
                      videoR2={videoR2.available}
                      onOpenSettings={href =>
                        guard(() => {
                          setLegendOpen(false);
                          setExpandedCatalogId(null);
                          navigateTo(href);
                        })
                      }
                    />
                    {needsVideo(row) && row.profile?.restitchStatus === 'blocked' && (
                      <p className="catalog-result-attention">
                        {t('catalogIconsReadinessWarning')}{' '}
                        {row.profile?.restitchBlockedCode &&
                          teamErrorMessageFor({ code: row.profile?.restitchBlockedCode }, t)}
                      </p>
                    )}
                    {needsVideo(row) && row.profile?.restitchStatus === 'blocked' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          guard(() =>
                            navigateTo(spaceRouteFor(teamId, { kind: 'settings', tab: 'restitch' }))
                          )
                        }
                      >
                        {t('teamSettingsTabRestitch')}
                      </Button>
                    )}
                    <p role="status">
                      {t(
                        inline.states[row.catalogId]?.phase === 'pending'
                          ? 'catalogIconsSaving'
                          : inline.states[row.catalogId]?.phase === 'unknown'
                            ? 'catalogIconsUnknown'
                            : inline.states[row.catalogId]?.phase === 'conflict'
                              ? 'catalogIconsConflict'
                              : 'catalogIconsLegendHint'
                      )}
                    </p>
                    {inline.states[row.catalogId]?.phase === 'unknown' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void inline.reconcile(row.catalogId)}
                      >
                        {t('catalogIconsCheck')}
                      </Button>
                    )}
                    {['error', 'conflict'].includes(inline.states[row.catalogId]?.phase ?? '') && (
                      <div role="alert">
                        {inline.states[row.catalogId]?.code &&
                          teamErrorMessageFor({ code: inline.states[row.catalogId]?.code }, t)}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const state = inline.states[row.catalogId];
                            if (state) changeField(row, state.field, state.intended);
                          }}
                        >
                          {t('catalogIconsRetryIntent')}
                        </Button>
                      </div>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={inline.states[row.catalogId]?.phase === 'pending'}
                      onClick={() => setExpandedCatalogId(null)}
                    >
                      {t('catalogUpdaterClose')}
                    </Button>
                  </div>
                </Modal>
              )}
            {historyCatalogId === row.catalogId && client.listCatalogUpdateAttempts && (
              <Modal
                nested
                labelledBy={`${titleId}-history`}
                onClose={() => setHistoryCatalogId(null)}
                className="team-updater-detail"
                backdropClassName="team-updater-detail-backdrop"
                size="lg"
              >
                <h2 id={`${titleId}-history`}>{row.name}</h2>
                <CatalogStatusDetails
                  teamId={teamId}
                  catalogId={row.catalogId}
                  currentProfileVersion={row.profile?.version}
                  activeAttemptId={row.activeAttemptId}
                  currentFailureCode={row.lastUpdateError}
                  checkingDelivery={Boolean(row.profile?.reconciliationRequired)}
                  retryDisabled={
                    inline.blocked(row.catalogId) ||
                    busyIds.has(row.catalogId) ||
                    row.updatePending ||
                    row.profile?.reconciliationRequired
                  }
                  load={client.listCatalogUpdateAttempts}
                  onClose={() => {
                    setHistoryCatalogId(null);
                    requestAnimationFrame(() => {
                      if (!owner.current()) return;
                      Array.from(
                        listRef.current?.querySelectorAll<HTMLElement>('[data-catalog-id]') ?? []
                      )
                        .find(element => element.dataset.catalogId === row.catalogId)
                        ?.querySelector<HTMLButtonElement>('.team-updater-row-actions button')
                        ?.focus();
                    });
                  }}
                  onRetry={
                    mayRun
                      ? async sourceAttemptId => {
                          if (
                            !owner.current() ||
                            inline.blocked(row.catalogId) ||
                            commands.blocked(row.catalogId) ||
                            busyRef.current.has(row.catalogId)
                          )
                            throw new TeamApiError('WRONG_STATE', false);
                          const outcome = await commands.submit([row.catalogId], sourceAttemptId);
                          if (outcome.kind === 'rejected' || outcome.kind === 'unknown')
                            throw outcome.error;
                        }
                      : undefined
                  }
                />
              </Modal>
            )}
          </div>
        ))}
      {bulkOpen && client.patchCatalogUpdateProfile && (
        <Modal
          nested
          labelledBy={`${titleId}-bulk`}
          onClose={() =>
            guard(() => {
              setBulkOpen(false);
              setEditorDirty(false);
            })
          }
          className="team-updater-detail"
          backdropClassName="team-updater-detail-backdrop"
          size="lg"
        >
          <h2 id={`${titleId}-bulk`}>{t('catalogUpdaterBulkSettings')}</h2>
          <CatalogBulkEditor
            clockOffsetMs={updater.offsetMs}
            mode={bulkMode}
            items={liveSelected
              .filter(row => row.profile && !inline.blocked(row.catalogId))
              .map(row => ({
                catalogId: row.catalogId,
                name: row.name,
                profile: row.profile!,
                productCount: row.productCount,
                interval: row.updateInterval
              }))}
            save={(id, version, patch) =>
              client.patchCatalogUpdateProfile!(teamId, id, version, patch, owner.options())
            }
            read={(id, options) => readCatalogSnapshot(client, teamId, id, options?.signal)}
            onDirtyChange={setEditorDirty}
            onPendingChange={setEditorPending}
            onUncertainChange={setEditorUncertain}
            onSaved={() => {
              if (!owner.current()) return;
              registry.reload();
              onChanged?.();
            }}
          />
          <Button
            variant="ghost"
            onClick={() =>
              guard(() => {
                setBulkOpen(false);
                setEditorDirty(false);
              })
            }
          >
            {t('catalogUpdaterClose')}
          </Button>
        </Modal>
      )}
      {discardAction && (
        <ConfirmDialog
          nested
          title={t(
            closeUncertain ? 'catalogUpdaterUncertainCloseTitle' : 'catalogUpdaterDiscardTitle'
          )}
          body={t(
            closeUncertain ? 'catalogUpdaterUncertainCloseBody' : 'catalogUpdaterDiscardBody'
          )}
          confirmLabel={t(closeUncertain ? 'catalogUpdaterClose' : 'catalogUpdaterDiscard')}
          cancelLabel={t('catalogUpdaterKeepEditing')}
          onCancel={() => setDiscardAction(null)}
          onConfirm={() => {
            const action = discardAction;
            setDiscardAction(null);
            setEditorDirty(false);
            action();
          }}
        />
      )}
      {excludedRuns && (
        <ConfirmDialog
          nested
          title={t('catalogIconsExcluded')}
          body={excludedRuns
            .filter(
              id =>
                inline.blocked(id) ||
                busyIds.has(id) ||
                rowsById.get(id)?.updatePending ||
                rowsById.get(id)?.profile?.reconciliationRequired
            )
            .map(
              id =>
                `${rowsById.get(id)?.name}: ${inline.blocked(id) || busyIds.has(id) ? t('catalogIconsPendingRun') : rowsById.get(id)?.updatePending ? t('catalogUpdaterUpdatingNow') : t('catalogUpdaterReconciliationHold')}`
            )
            .join('; ')}
          confirmLabel={t('catalogIconsRunReady')}
          cancelLabel={t('catalogUpdaterClose')}
          onCancel={() => setExcludedRuns(null)}
          onConfirm={() => {
            const ids = excludedRuns.filter(
              id =>
                !inline.blocked(id) &&
                !busyIds.has(id) &&
                !rowsById.get(id)?.updatePending &&
                !rowsById.get(id)?.profile?.reconciliationRequired
            );
            setExcludedRuns(null);
            if (ids.length) void updateNow(ids);
          }}
        />
      )}
      <div className="catalog-undo-notice" role="status">
        {undoToast && (
          <>
            <span>
              {rowsById.get(undoToast.catalogId)?.name} · {t('catalogIconsSaved')}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={
                !mayRun ||
                inline.blocked(undoToast.catalogId) ||
                inline.snapshotFor(undoToast.catalogId)?.profile.version !== undoToast.version
              }
              data-setting-save={
                inline.states[undoToast.catalogId]?.phase === 'pending' ? 'true' : undefined
              }
              onClick={() => void inline.undoChange(undoToast)}
            >
              {t('catalogIconsUndo')}
            </Button>
          </>
        )}
      </div>
      {recentOpen && (
        <Modal
          nested
          labelledBy={`${titleId}-recent`}
          onClose={() => setRecentOpen(false)}
          size="lg"
        >
          <h2 id={`${titleId}-recent`}>{t('catalogIconsRecent')}</h2>
          <div className="catalog-recent-list">
            {inline.undo.map(entry => {
              const row = rowsById.get(entry.catalogId);
              const invalid = entry.invalid || row?.profile?.version !== entry.version;
              const label =
                entry.field === 'videoVariantCount'
                  ? t('catalogVideoVariationCount')
                  : entry.field === 'updateInterval' || entry.field === 'schedule'
                    ? t('catalogIconsSchedule')
                    : t(CATALOG_FIELDS.find(item => item.field === entry.field)!.label);
              return (
                <div key={`${entry.catalogId}-${entry.field}`}>
                  <strong>{row?.name ?? t('catalogUpdaterProfileUnknown')}</strong>
                  <span>
                    {label}:{' '}
                    {typeof entry.after === 'number'
                      ? entry.after
                      : typeof entry.after === 'boolean'
                        ? t(entry.after ? 'catalogUpdaterBulkOn' : 'catalogUpdaterBulkOff')
                        : intervalLabel(
                            typeof entry.after === 'object' && entry.after !== null
                              ? entry.after.interval
                              : entry.after,
                            t
                          )}
                  </span>
                  {invalid && <small>{t('catalogIconsUndoInvalid')}</small>}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      inline.states[entry.catalogId]?.phase === 'unknown'
                        ? false
                        : invalid || inline.blocked(entry.catalogId) || !mayRun
                    }
                    onClick={() => {
                      recentReturnTarget.current = {
                        catalogId: entry.catalogId,
                        field: entry.field
                      };
                      if (inline.states[entry.catalogId]?.phase === 'unknown')
                        void inline.reconcile(entry.catalogId);
                      else void inline.undoChange(entry);
                    }}
                  >
                    {t(
                      inline.states[entry.catalogId]?.phase === 'unknown'
                        ? 'catalogIconsCheck'
                        : 'catalogIconsUndo'
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              recentReturnTarget.current = {};
              inline.clearUndo();
            }}
          >
            {t('catalogIconsClearRecent')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRecentOpen(false)}>
            {t('catalogUpdaterClose')}
          </Button>
        </Modal>
      )}
      {videoVariationsRow && (
        <CatalogVideoVariationsDialog
          teamId={teamId}
          row={videoVariationsRow}
          onClose={() => setVideoVariationsRow(null)}
          onChanged={registry.reload}
        />
      )}
      {publicationCatalogId && (
        <CatalogPublicationDialog
          teamId={teamId}
          catalogId={publicationCatalogId}
          clockOffsetMs={updater.offsetMs}
          onClose={() => setPublicationCatalogId(null)}
          onChanged={registry.reload}
        />
      )}
      {/* In the space's corner stack, which sits above dialogs: inside the
          dialog it was a second copy of the same panel, in the wrong corner. */}
      {managerTrash &&
        receipts.length > 0 &&
        createPortal(
          space?.stack ? trashPanels : <div className="team-process-stack">{trashPanels}</div>,
          space?.stack ?? document.body
        )}
      {confirmDelete.length > 0 && (
        <ConfirmDialog
          nested
          title={t('catalogUpdaterDeleteSelected')}
          body={
            confirmDelete.some(id => videoR2.row(id).enabled)
              ? `${t(catalogDeleteConfirmKey(language, confirmDelete.length), { count: confirmDelete.length })} ${t('catalogVideoR2DeleteWarning')}`
              : t(catalogDeleteConfirmKey(language, confirmDelete.length), {
                  count: confirmDelete.length
                })
          }
          confirmLabel={t('catalogUpdaterDeleteSelected')}
          cancelLabel={t('teamCancel')}
          busy={busyIds.size > 0}
          onCancel={() => setConfirmDelete([])}
          onConfirm={() => void deleteSelected()}
        />
      )}
    </Modal>
  );
}
