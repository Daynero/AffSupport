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
import { catalogSelectedCountKey, useI18n } from '../../i18n';
import { searchFieldEscape } from '../../lib/searchField';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { UpdaterIntervalPicker, intervalLabel } from './UpdaterIntervalPicker';
import { navigateTo, BEFORE_NAVIGATION_EVENT } from '../../lib/navigation';
import { spaceRouteFor } from '../SpaceSettingsLink';
import { DropdownMenu } from '../../components/ui/index';
import { beginCatalogUiFlow } from './analytics';
import { UpdaterRowActions } from './UpdaterRowActions';
import { CatalogProgressRow } from './CatalogProgressRow';
import { CatalogUpdateProgress } from './CatalogUpdateProgress';
import { CatalogIdentity } from './CatalogIdentity';
import { CatalogIconControls, CatalogIconLegend, CATALOG_FIELDS } from './CatalogIconControls';
import { useCatalogInlineChanges } from './useCatalogInlineChanges';
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

export interface CatalogUpdaterDialogClient extends CatalogUpdaterClient {
  setCatalogUpdateInterval: (
    teamId: string,
    catalogIds: string[],
    interval: CatalogUpdaterInterval | null
  ) => Promise<CatalogUpdaterState>;
  runCatalogUpdateNow: (teamId: string, catalogIds: string[]) => Promise<number>;
  cancelCatalogUpdate?: (teamId: string, catalogId: string) => Promise<boolean>;
  listCatalogUpdateAttempts?: (
    teamId: string,
    catalogId: string
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

function needsAttention(row: CatalogRegistryRow) {
  if (row.profile?.reconciliationRequired) return row.profile.lastResult !== 'running';
  if (row.updatePending)
    return Boolean(
      row.profile?.restitch &&
      row.profile.restitchStatus === 'blocked' &&
      row.profile.restitchBlockedCode
    );
  return Boolean(
    row.lastUpdateError ||
    ['failed', 'partial', 'unknown'].includes(row.profile?.lastResult ?? '') ||
    (row.profile?.restitch && row.profile.restitchStatus === 'blocked')
  );
}

export function CatalogUpdaterDialog({
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
  const { t, language } = useI18n();
  const { push } = useToasts();
  const { can, permissions } = useTeam();
  const titleId = useId();
  const searchId = useId();
  const mayRun = can('process');

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
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
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
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const guard = (action: () => void) => {
    if (editorPending || Object.values(inline.states).some(state => state.phase === 'pending'))
      return;
    if (editorDirty) setDiscardAction(() => action);
    else action();
  };

  useEffect(() => {
    const prevent = (event: Event) => {
      if (
        editorPending ||
        Object.values(inline.states).some(state => state.phase === 'pending') ||
        (editorDirty && !window.confirm(t('catalogUpdaterDiscardDraft')))
      )
        event.preventDefault();
    };
    window.addEventListener(BEFORE_NAVIGATION_EVENT, prevent);
    return () => window.removeEventListener(BEFORE_NAVIGATION_EVENT, prevent);
  }, [editorDirty, editorPending, inline.hasPending, t]);
  const listFlow = useRef<ReturnType<typeof beginCatalogUiFlow> | null>(null);
  useEffect(() => {
    const flow = beginCatalogUiFlow('list');
    listFlow.current = flow;
    return () => flow.cancel();
  }, []);
  useEffect(() => {
    if (registry.rows !== null) {
      listFlow.current?.stage('result_visible');
      listFlow.current?.complete();
    } else if (registry.error) listFlow.current?.fail('READ_FAILED');
  }, [registry.rows, registry.error]);
  const [expandedCatalogId, setExpandedCatalogId] = useState<string | null>(null);
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
  const duplicateNames = new Set(
    rows
      .filter((row, index) => rows.findIndex(other => other.name === row.name) !== index)
      .map(row => row.name)
  );
  const heldRows = useRef(new Map<string, CatalogRegistryRow>());
  const listRef = useRef<HTMLTableElement>(null);
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
  const withBusy = async (ids: string[], work: () => Promise<void>) => {
    if (ids.some(id => busyRef.current.has(id))) return;
    ids.forEach(id => busyRef.current.add(id));
    setBusyIds(current => new Set([...current, ...ids]));
    try {
      await work();
      updater.reload();
      registry.reload();
      onChanged?.();
    } catch (error) {
      push({ tone: 'error', text: teamErrorMessageFor(error, t) });
    } finally {
      ids.forEach(id => busyRef.current.delete(id));
      setBusyIds(current => new Set([...current].filter(id => !ids.includes(id))));
    }
  };

  const executeNow = (ids: string[]) => {
    if (ids.some(id => inline.blocked(id) || busyRef.current.has(id))) return;
    if (rows.some(row => ids.includes(row.catalogId) && row.profile?.reconciliationRequired)) {
      push({ tone: 'error', text: t('catalogUpdaterReconciliationHold') });
      return;
    }
    return withBusy(ids, async () => {
      const opened = await client.runCatalogUpdateNow(teamId, ids);
      push({
        tone: 'success',
        text:
          opened === 0
            ? t('catalogUpdaterNowAlready')
            : t('catalogUpdaterNowStarted', { count: opened })
      });
    });
  };

  const updateNow = (ids: string[]) => {
    const excluded = ids.filter(
      id =>
        inline.blocked(id) ||
        busyIds.has(id) ||
        rows.find(row => row.catalogId === id)?.profile?.reconciliationRequired ||
        rows.find(row => row.catalogId === id)?.updatePending
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
    if (!mayRun || inline.blocked(row.catalogId) || busyRef.current.has(row.catalogId)) return;
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

  const cancelNow = (id: string) =>
    withBusy([id], async () => {
      await client.cancelCatalogUpdate?.(teamId, id);
    });

  const deleteSelected = async () => {
    const ids = confirmDelete;
    await withBusy(ids, async () => {
      for (const materialId of ids) {
        await teamApi.trashMaterial({ teamId, materialId, idempotencyKey: crypto.randomUUID() });
      }
      setSelected(current => new Set([...current].filter(id => !ids.includes(id))));
      setConfirmDelete([]);
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
        ? t('catalogUpdaterLoading')
        : t('catalogUpdaterListSummary', {
            count: rows.length,
            scheduled: rows.filter(row => row.updateInterval !== null).length,
            attention: rows.filter(needsAttention).length
          })}
    </p>
  );

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
        {registry.rows !== null && rows.length === 0 && (
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
                const row =
                  rows.find(row => row.catalogId === filteredRow.catalogId) ?? filteredRow;
                const busy = busyIds.has(row.catalogId) || inline.blocked(row.catalogId);
                const successfulAt = lastSuccess(row);
                const result = row.profile?.lastResult;
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
                            parts={nameParts(row.name)}
                            context={`${row.videoName} · ${row.folderName ?? t('catalogUpdaterSpaceRoot')}`}
                            sheetUrl={row.sheetUrl}
                            onConfigure={() => setExpandedCatalogId(row.catalogId)}
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
                      <span
                        className={`catalog-row-feedback${(row.profile?.reconciliationRequired && row.profile.lastResult === 'running') || (row.updatePending && !row.profile?.reconciliationRequired && row.profile?.restitchStatus !== 'blocked') ? ' sr-only' : ''}`}
                        role="status"
                      >
                        {row.profile?.reconciliationRequired &&
                        row.profile.lastResult === 'running' ? (
                          t('catalogUpdaterStageVerifying')
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
                        ) : row.updatePending &&
                          row.profile?.restitch &&
                          row.profile.restitchStatus === 'blocked' &&
                          row.profile.restitchBlockedCode ? (
                          <button
                            type="button"
                            className="catalog-outcome-details"
                            onClick={() => setExpandedCatalogId(row.catalogId)}
                          >
                            {t('catalogRunVideoRetryWaiting')}
                          </button>
                        ) : row.updatePending ? (
                          t(
                            row.profile?.restitch && row.profile.restitchStatus !== 'ready'
                              ? row.profile.restitchStatus === 'preparing'
                                ? 'catalogRunPreparingVideo'
                                : 'catalogRunVideoWaiting'
                              : 'catalogUpdaterUpdatingNow'
                          )
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
                        ) : row.profile?.restitch && row.profile.restitchStatus === 'blocked' ? (
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
                          name={row.name}
                          state={state}
                          disabledReason={disabledReason}
                          onChange={(field, value) => changeField(row, field, value)}
                          onReadiness={() => setExpandedCatalogId(row.catalogId)}
                        />
                      ) : (
                        <small>{t('catalogUpdaterProfileUnknown')}</small>
                      )}
                    </td>
                    <td className="catalog-schedule-cell">
                      <UpdaterIntervalPicker
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
                            variant="ghost"
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
                                ? void cancelNow(row.catalogId)
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
                            row={row}
                            teamId={teamId}
                            permissions={permissions}
                            onChanged={registry.reload}
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
                variant="ghost"
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
                    />
                    <CatalogIconLegend
                      teamId={teamId}
                      onOpenSettings={href =>
                        guard(() => {
                          setLegendOpen(false);
                          setExpandedCatalogId(null);
                          navigateTo(href);
                        })
                      }
                    />
                    {row.profile.restitch && row.profile.restitchStatus === 'blocked' && (
                      <p className="catalog-result-attention">
                        {t('catalogIconsReadinessWarning')}{' '}
                        {row.profile.restitchBlockedCode &&
                          teamErrorMessageFor({ code: row.profile.restitchBlockedCode }, t)}
                      </p>
                    )}
                    {row.profile.restitch && row.profile.restitchStatus === 'blocked' && (
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
                    requestAnimationFrame(() =>
                      Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
                        .find(
                          button =>
                            button.getAttribute('aria-label') ===
                            t('materialActionsFor', { name: row.name })
                        )
                        ?.focus()
                    );
                  }}
                  onRetry={
                    mayRun && client.retryCatalogUpdate
                      ? async sourceAttemptId => {
                          setBusyIds(current => new Set([...current, row.catalogId]));
                          try {
                            await client.retryCatalogUpdate!(
                              teamId,
                              row.catalogId,
                              sourceAttemptId
                            );
                            push({
                              tone: 'success',
                              text: t('catalogUpdaterNowStarted', { count: 1 })
                            });
                            registry.reload();
                            updater.reload();
                            onChanged?.();
                          } catch (error) {
                            push({ tone: 'error', text: teamErrorMessageFor(error, t) });
                            throw error;
                          } finally {
                            setBusyIds(
                              current => new Set([...current].filter(id => id !== row.catalogId))
                            );
                          }
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
            mode={bulkMode}
            items={liveSelected
              .filter(row => row.profile && !inline.blocked(row.catalogId))
              .map(row => ({
                catalogId: row.catalogId,
                name: row.name,
                profile: row.profile!,
                interval: row.updateInterval
              }))}
            save={(id, version, patch) =>
              client.patchCatalogUpdateProfile!(teamId, id, version, patch)
            }
            onDirtyChange={setEditorDirty}
            onPendingChange={setEditorPending}
            onSaved={() => {
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
          title={t('catalogUpdaterDiscardTitle')}
          body={t('catalogUpdaterDiscardBody')}
          confirmLabel={t('catalogUpdaterDiscard')}
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
                rows.find(row => row.catalogId === id)?.updatePending ||
                rows.find(row => row.catalogId === id)?.profile?.reconciliationRequired
            )
            .map(
              id =>
                `${rows.find(row => row.catalogId === id)?.name}: ${inline.blocked(id) || busyIds.has(id) ? t('catalogIconsPendingRun') : rows.find(row => row.catalogId === id)?.updatePending ? t('catalogUpdaterUpdatingNow') : t('catalogUpdaterReconciliationHold')}`
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
                !rows.find(row => row.catalogId === id)?.updatePending &&
                !rows.find(row => row.catalogId === id)?.profile?.reconciliationRequired
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
              {rows.find(row => row.catalogId === undoToast.catalogId)?.name} ·{' '}
              {t('catalogIconsSaved')}
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
              const row = rows.find(row => row.catalogId === entry.catalogId);
              const invalid = entry.invalid || row?.profile?.version !== entry.version;
              const label =
                entry.field === 'updateInterval' || entry.field === 'schedule'
                  ? t('catalogIconsSchedule')
                  : t(CATALOG_FIELDS.find(item => item.field === entry.field)!.label);
              return (
                <div key={`${entry.catalogId}-${entry.field}`}>
                  <strong>{row?.name ?? t('catalogUpdaterProfileUnknown')}</strong>
                  <span>
                    {label}:{' '}
                    {typeof entry.after === 'boolean'
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
                    disabled={invalid || inline.blocked(entry.catalogId) || !mayRun}
                    onClick={() => void inline.undoChange(entry)}
                  >
                    {t('catalogIconsUndo')}
                  </Button>
                </div>
              );
            })}
          </div>
          <Button size="sm" variant="ghost" onClick={inline.clearUndo}>
            {t('catalogUpdaterClearSelection')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRecentOpen(false)}>
            {t('catalogUpdaterClose')}
          </Button>
        </Modal>
      )}
      {confirmDelete.length > 0 && (
        <ConfirmDialog
          nested
          title={t('catalogUpdaterDeleteSelected')}
          body={t('catalogUpdaterDeleteConfirm', { count: confirmDelete.length })}
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
