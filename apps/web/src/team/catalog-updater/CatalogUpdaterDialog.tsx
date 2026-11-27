import { captureCatalogMutationOwner } from './captureCatalogMutationOwner';
import { useCatalogCommands, type CatalogCommandClient } from './useCatalogCommands';
import { privateClientId, usePrivateCacheEpoch } from '../private-cache-scope';
import { withReadDeadline } from '../readCoordinator';
import type { TeamAnalyticsStorage } from '@video-compressor/shared';
import { useOptionalSpaceAgentQueue } from '../processing/AgentQueueProvider';
import { createPortal } from 'react-dom';
import { TeamApiError } from '../../api/team';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  CatalogMutationOptions,
  CatalogRegistryRow,
  CatalogUpdaterInterval,
  CatalogUpdaterState
} from '../../api/team';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Alert, Button } from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { catalogErrorMessageFor } from '../catalogFixActions';
import { useTeam } from '../TeamContext';
import { navigateTo, BEFORE_NAVIGATION_EVENT } from '../../lib/navigation';
import { spaceRouteFor } from '../SpaceSettingsLink';
import { beginCatalogUiFlow } from './analytics';
import { useCatalogVideoR2Team } from '../product-catalog/useCatalogVideoR2Team';
import { useCatalogInlineChanges, type CatalogField } from './useCatalogInlineChanges';
import {
  useCatalogRegistry,
  useCatalogUpdater,
  type CatalogUpdaterClient
} from './useCatalogUpdater';
import { CatalogCommandNotices } from './CatalogCommandNotices';
import type { CatalogRowContext } from './CatalogUpdaterRow';
import { CatalogUpdaterList } from './CatalogUpdaterList';
import {
  CatalogUpdaterBulkBar,
  CatalogUpdaterFilters,
  CatalogUpdaterHeader,
  CatalogUpdaterToolbar
} from './CatalogUpdaterToolbar';
import { CatalogUpdaterWindows } from './CatalogUpdaterWindows';
import { CatalogUpdaterSideDialogs } from './CatalogUpdaterSideDialogs';
import { shownCatalogRows, useCatalogDates } from './catalogRowState';
import { useCatalogManagerTrash } from './useCatalogManagerTrash';
import { useCatalogStop } from './useCatalogStop';
import { useCatalogListFocus } from './useCatalogListFocus';
import { catalogSettingsLock } from './catalogRowActivity';
import {
  restitchSettingsFailed,
  useRestitchSettingsReady,
  wantsRestitch,
  type RestitchDefaultsReader
} from './useRestitchSettingsReady';

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
  /** Effective re-stitch settings; null when the space has both screens off (2026-11-25). */
  getRestitchDefaults?: RestitchDefaultsReader;
}

const defaultClient: CatalogUpdaterDialogClient = teamApi;

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
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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
  const space = useOptionalSpaceAgentQueue();
  const { can, permissions } = useTeam();
  const titleId = useId();
  const searchId = useId();
  const mayRun = can('process');
  // 050: the R2 option is one more icon beside the auto-update choices.
  const videoR2 = useCatalogVideoR2Team(teamId);
  const videoR2For = (catalogId: string, locked?: string, kind?: 'video' | 'image') =>
    videoR2.available || kind === 'image'
      ? {
          row: videoR2.row(catalogId),
          disabledReason: !videoR2.canManage ? t('catalogVideoR2NoPermission') : locked,
          onToggle: (next: boolean) => void videoR2.toggle(catalogId, next, kind)
        }
      : undefined;

  const updater = useCatalogUpdater(teamId, client);
  const registry = useCatalogRegistry(teamId, true, client);
  const [replaceVideoCatalogId, setReplaceVideoCatalogId] = useState<string | null>(null);
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
  /* The video a catalog was made from, and its other catalogs (070, T057). */
  const [videoCatalogsRow, setVideoCatalogsRow] = useState<CatalogRegistryRow | null>(null);

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
  const isRunning = (row: CatalogRegistryRow | undefined) =>
    Boolean(row && catalogSettingsLock(row, Date.now() + updater.offsetMs));
  // Re-stitching works out of the box; the one case it cannot is a space with both the start and
  // the end turned off. Such a run is refused where it was pressed, with the way to the setting,
  // instead of a round that waits «Готуємо відео…» for ever (production 2026-11-25).
  const restitchSettings = useRestitchSettingsReady(teamId, client.getRestitchDefaults);
  const [restitchRefused, setRestitchRefused] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (restitchSettings.state === 'ready') setRestitchRefused(new Set());
  }, [restitchSettings.state]);
  const markRestitchRefused = (ids: readonly string[]) =>
    setRestitchRefused(current => new Set([...current, ...ids]));
  /** The catalogs among these whose re-stitching cannot run here; each row is told why. */
  const refuseWithoutRestitch = async (ids: string[]): Promise<string[]> => {
    const wanting = ids.filter(id => wantsRestitch(rowsById.get(id)));
    if (!wanting.length) return [];
    const state = restitchSettings.state === 'ready' ? 'ready' : await restitchSettings.recheck();
    if (state !== 'missing') return [];
    if (owner.current()) markRestitchRefused(wanting);
    return wanting;
  };
  const scheduledRestitchCount = rows.filter(
    row => wantsRestitch(row) && row.updateInterval !== null
  ).length;
  const nameCounts = new Map<string, number>();
  for (const row of rows) nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
  const duplicateNames = new Set(
    [...nameCounts].filter(([, count]) => count > 1).map(([name]) => name)
  );
  const heldRows = useRef(new Map<string, CatalogRegistryRow>());
  const listRef = useRef<HTMLTableElement>(null);
  const [changeNotice, setChangeNotice] = useState('');
  const [heldRevision, setHeldRevision] = useState(0);
  useCatalogListFocus({
    owner,
    listRef,
    searchId,
    recentOpen,
    setRecentOpen,
    recentReturnTarget,
    undoCount: inline.undo.length,
    heldRows,
    inlineStates: inline.states,
    setHeldRevision,
    setChangeNotice,
    t
  });
  const shown = useMemo(
    () =>
      // A held row keeps its place in the filters and the order while its change is saved; what
      // the row shows is always the live one (072, П5: a held copy froze «run» over a round that
      // had started meanwhile).
      shownCatalogRows(
        rows.map(row => heldRows.current.get(row.catalogId) ?? row),
        { query, status: statusFilter, recency: recencyFilter, sortBy, createdRange }
      ).map(row => rowsById.get(row.catalogId) ?? row),
    [rows, rowsById, query, statusFilter, recencyFilter, sortBy, heldRevision, createdRange]
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
        push({ tone: 'error', text: catalogErrorMessageFor(outcome.error, t) });
    });
  };

  const updateNow = async (requested: string[]) => {
    const refused = await refuseWithoutRestitch(requested);
    if (!owner.current()) return;
    // A row says it in place; a selection may hide some rows, so it is also said once here.
    if (refused.length && requested.length > 1)
      push({ tone: 'error', text: t('catalogRestitchOff') });
    const ids = requested.filter(id => !refused.includes(id));
    if (!ids.length) return;
    const excluded = ids.filter(
      id =>
        inline.blocked(id) ||
        busyIds.has(id) ||
        rowsById.get(id)?.profile?.reconciliationRequired ||
        isRunning(rowsById.get(id))
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
      busyRef.current.has(row.catalogId) ||
      // 072 П5: a running catalog's settings wait for the round (the server refuses them too).
      isRunning(row)
    )
      return;
    // A schedule that would re-stitch in a space with both screens off is not saved.
    const schedulesRestitch =
      (field === 'updateInterval' && value !== null && wantsRestitch(row)) ||
      (field === 'restitch' && value === true && row.updateInterval !== null);
    if (schedulesRestitch && restitchSettings.state === 'missing') {
      markRestitchRefused([row.catalogId]);
      return;
    }
    heldRows.current.set(row.catalogId, row);
    void inline.change(row.catalogId, field, value);
  };
  useEffect(() => {
    for (const row of shown.slice(0, visibleCount)) inline.delivered(row.catalogId);
  });
  const blocked = (id: string) => inline.blocked(id) || commands.blocked(id);
  const { cancelNow } = useCatalogStop({
    teamId,
    client,
    owner,
    push,
    toasts,
    t,
    busyRef,
    withBusy,
    blocked
  });
  const { managerTrash, receipts, trashPanels, deleteSelected } = useCatalogManagerTrash({
    teamId,
    rows,
    permissions,
    owner,
    withBusy,
    setSelected,
    confirmDelete,
    setConfirmDelete,
    reload: registry.reload,
    onChanged,
    push,
    t
  });

  const { when, shortWhen, createdDateFormat } = useCatalogDates(language);

  const ctx: CatalogRowContext = {
    teamId,
    client,
    mayRun,
    permissions,
    storageKind: storageContext?.teamId === teamId ? storageContext.kind : null,
    clockOffsetMs: updater.offsetMs,
    editorPending,
    busyIds,
    inline,
    when,
    shortWhen,
    createdDate: createdDateFormat,
    changeField,
    saveSchedule: async (row, interval, schedule) => {
      if (!mayRun) throw new TeamApiError('PERMISSION_DENIED', false);
      if (busyRef.current.has(row.catalogId) || isRunning(row))
        throw new TeamApiError('WRONG_STATE', false);
      if (interval !== null && (await refuseWithoutRestitch([row.catalogId])).length)
        throw new TeamApiError('RESTITCH_INVALID', false);
      await inline.saveSchedule(row.catalogId, { interval, schedule });
    },
    videoR2For,
    onReveal,
    open: (what, row) => {
      if (what === 'configure') setExpandedCatalogId(row.catalogId);
      else if (what === 'history') setHistoryCatalogId(row.catalogId);
      else if (what === 'rename') openRename(row);
      else if (what === 'videoVariations') setVideoVariationsRow(row);
      else if (what === 'publication') setPublicationCatalogId(row.catalogId);
      else setVideoCatalogsRow(row);
    },
    restitchOff: row =>
      restitchSettings.state !== 'ready' &&
      (restitchRefused.has(row.catalogId) || restitchSettingsFailed(row)),
    openRestitchSettings: () =>
      guard(() => navigateTo(spaceRouteFor(teamId, { kind: 'settings', tab: 'restitch' }))),
    run: row => void updateNow([row.catalogId]),
    stop: row => void cancelNow(row),
    reload: registry.reload
  };
  const clearFilters = () => {
    setStatusFilter('all');
    setRecencyFilter('all');
    setCreatedRange({ from: '', to: '' });
    setSortBy('created');
  };

  return (
    <Modal
      bare
      labelledBy={titleId}
      onClose={() => guard(onClose)}
      backdropClassName="team-updater-backdrop"
      className="team-updater-dialog catalog-manager-dialog"
      initialFocus={`[id="${searchId}"]`}
    >
      <CatalogUpdaterHeader
        titleId={titleId}
        rows={rows}
        loading={registry.rows === null}
        unavailable={Boolean(registry.error)}
        onAttention={() => setStatusFilter('failed')}
        onClose={() => guard(onClose)}
        menuItems={[
          {
            id: 'settings',
            label: t('catalogUpdaterSpaceSettings'),
            onSelect: () =>
              guard(() =>
                navigateTo(spaceRouteFor(teamId, { kind: 'settings', tab: 'product-catalog' }))
              )
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

      {notice}
      {mayRun && restitchSettings.state === 'missing' && scheduledRestitchCount > 0 && (
        <Alert
          color="warning"
          className="catalog-restitch-off-notice"
          title={t('catalogRestitchOffTitle')}
          action={
            <Button size="sm" color="neutral" onClick={ctx.openRestitchSettings}>
              {t('catalogOpenRestitchSettings')}
            </Button>
          }
        >
          {t('catalogRestitchOffScheduled', { count: scheduledRestitchCount })}
        </Alert>
      )}

      <CatalogUpdaterToolbar
        searchId={searchId}
        query={query}
        onQuery={setQuery}
        filtersOpen={filtersOpen}
        onToggleFilters={() => setFiltersOpen(value => !value)}
        activeFilters={[statusFilter, recencyFilter].filter(value => value !== 'all').length}
        createdRange={createdRange}
        onCreatedRange={setCreatedRange}
        legendOpen={legendOpen}
        onLegend={() => {
          setLegendOpen(value => !value);
          localStorage.setItem('catalog-icon-legend-seen', '1');
        }}
        recentCount={inline.undo.length}
        onRecent={() => setRecentOpen(true)}
        selectAll={
          mayRun
            ? {
                checked: allShownChosen,
                indeterminate: shownChosen > 0 && !allShownChosen,
                disabled: shown.length === 0,
                onToggle: toggleShown
              }
            : undefined
        }
      />
      <span className="sr-only" role="status">
        {changeNotice}
      </span>
      <CatalogUpdaterFilters
        open={filtersOpen}
        status={statusFilter}
        recency={recencyFilter}
        sortBy={sortBy}
        onRecency={setRecencyFilter}
        onSortBy={setSortBy}
        onClear={clearFilters}
      />
      <CatalogCommandNotices
        titleId={titleId}
        commands={commands}
        rowsById={rowsById}
        mayRun={mayRun}
        owner={owner}
        push={push}
        stale={Boolean(registry.error) && registry.rows !== null}
        lastLoadedAt={registry.lastLoadedAt}
        invalidRowCount={registry.invalidRowCount}
        when={when}
        onReload={registry.reload}
      />

      <CatalogUpdaterList
        rows={rows}
        shown={shown}
        rowsById={rowsById}
        ctx={ctx}
        selected={selected}
        duplicateNames={duplicateNames}
        visibleCount={visibleCount}
        loading={registry.rows === null}
        failed={Boolean(registry.error)}
        invalidRowCount={registry.invalidRowCount}
        listRef={listRef}
        onToggle={toggle}
        onShowMore={() => setVisibleCount(count => count + 60)}
        onReload={registry.reload}
        onBrowseFiles={() => guard(onClose)}
        onClearFilters={() => {
          setQuery('');
          setStatusFilter('all');
          setRecencyFilter('all');
          setCreatedRange({ from: '', to: '' });
        }}
      />

      <CatalogUpdaterSideDialogs
        busyIds={busyIds}
        closeUncertain={closeUncertain}
        confirmDelete={confirmDelete}
        deleteSelected={deleteSelected}
        discardAction={discardAction}
        excludedRuns={excludedRuns}
        inline={inline}
        mayRun={mayRun}
        onChanged={onChanged}
        permissions={permissions}
        publicationCatalogId={publicationCatalogId}
        registry={registry}
        renameOpen={renameOpen}
        renameRow={renameRow}
        replaceVideoCatalogId={replaceVideoCatalogId}
        rowsById={rowsById}
        setConfirmDelete={setConfirmDelete}
        setDiscardAction={setDiscardAction}
        setEditorDirty={setEditorDirty}
        setExcludedRuns={setExcludedRuns}
        setPublicationCatalogId={setPublicationCatalogId}
        setRenameOpen={setRenameOpen}
        setRenameRow={setRenameRow}
        setReplaceVideoCatalogId={setReplaceVideoCatalogId}
        setVideoCatalogsRow={setVideoCatalogsRow}
        setVideoVariationsRow={setVideoVariationsRow}
        teamId={teamId}
        updateNow={updateNow}
        clockOffsetMs={updater.offsetMs}
        videoCatalogsRow={videoCatalogsRow}
        videoR2={videoR2}
        videoVariationsRow={videoVariationsRow}
      />
      <CatalogUpdaterBulkBar
        selected={liveSelected.length}
        hidden={liveSelected.length - shownChosen}
        mayRun={mayRun}
        canConfigure={
          Boolean(client.patchCatalogUpdateProfile) && liveSelected.every(row => row.profile)
        }
        pending={inline.hasPending}
        onConfigure={mode => {
          setBulkMode(mode);
          setBulkOpen(true);
        }}
        onRunNow={() => void updateNow(liveSelected.map(row => row.catalogId))}
        onClear={() => setSelected(new Set())}
      />
      <CatalogUpdaterWindows
        titleId={titleId}
        teamId={teamId}
        client={client}
        rows={rows}
        rowsById={rowsById}
        liveSelected={liveSelected}
        mayRun={mayRun}
        permissions={permissions}
        editorPending={editorPending}
        clockOffsetMs={updater.offsetMs}
        busyIds={busyIds}
        busyRef={busyRef}
        inline={inline}
        commands={commands}
        owner={owner}
        videoR2={videoR2}
        videoR2For={videoR2For}
        changeField={changeField}
        when={when}
        shortWhen={shortWhen}
        guard={guard}
        legendOpen={legendOpen}
        setLegendOpen={setLegendOpen}
        expandedCatalogId={expandedCatalogId}
        setExpandedCatalogId={setExpandedCatalogId}
        historyCatalogId={historyCatalogId}
        setHistoryCatalogId={setHistoryCatalogId}
        bulkOpen={bulkOpen}
        setBulkOpen={setBulkOpen}
        bulkMode={bulkMode}
        recentOpen={recentOpen}
        setRecentOpen={setRecentOpen}
        recentReturnTarget={recentReturnTarget}
        setEditorDirty={setEditorDirty}
        setEditorPending={setEditorPending}
        setEditorUncertain={setEditorUncertain}
        setReplaceVideoCatalogId={setReplaceVideoCatalogId}
        listRef={listRef}
        registryReload={registry.reload}
        onChanged={onChanged}
        refuseWithoutRestitch={refuseWithoutRestitch}
        stopRow={row => void cancelNow(row)}
      />
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
      {/* In the space's corner stack, which sits above dialogs: inside the
          dialog it was a second copy of the same panel, in the wrong corner. */}
      {managerTrash &&
        receipts.length > 0 &&
        createPortal(
          space?.stack ? trashPanels : <div className="team-process-stack">{trashPanels}</div>,
          space?.stack ?? document.body
        )}
    </Modal>
  );
}
