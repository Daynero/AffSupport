import { privateCacheActorEpoch } from '../private-cache-scope.js';
import type { LaunchBatch } from './LaunchBatch.js';
import { onLaunchesChanged, registerLaunchRunner } from '../assistant/bridge.js';
import { launchCardState } from './launchPresentation.js';
import { batchEligible } from './batchModel.js';
import { durableCardValue, durableItemState } from './durableBatchModel.js';
import { ensureBackgroundRecovery } from '../../api/recovery.js';
import { observeBackgroundSetup } from '../catalog-updater/backgroundSetupAnalytics.js';
import { recoveryInstallation } from '../../api/recovery-installation.js';
import { useLaunchListSelection } from './useLaunchListSelection.js';
import { useOptionalToasts } from '../../components/toast';
import { launchBatchLoading, launchMutation } from './analytics';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Copy, Link2, ListChecks, MoreHorizontal, Play, Plus, Trash2 } from 'lucide-react';
import {
  LAUNCH_BATCH_MAX_ITEMS,
  launchInputsLocked,
  type LaunchDetail,
  type DurableLaunchBatch,
  type LaunchBatchCommand,
  type TeamAccountSummary
} from '@video-compressor/shared';
import { launchApi, teamApi, TeamApiError } from '../../api/team';
import type { LaunchDictionaryItem } from '../../api/launches';
import {
  Button,
  Checkbox,
  DropdownMenu,
  EmptyState,
  ErrorState,
  IconButton,
  Modal,
  PermissionState,
  SearchField,
  SelectionBar,
  LoadingState,
  Reveal,
  Skeleton
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { buildTeamRoute, emptyTeamRouteQuery, type TeamRouteQuery } from '../routes';
import { crossfadeLayout, navigateTo } from '../../lib/navigation';
import { TaskDateFilterControl } from '../tasks/TaskDateFilter';
import { TaskFiltersButton } from '../tasks/TaskFiltersButton';
import { encodeDateFilter, parseStoredDateFilter, type TaskDateFilter } from '../tasks/useTasks';
import { boundedText, persistedViewKey, usePersistedState } from '../persistedView';
import { LaunchCard } from './LaunchCard';
import { useLaunchMarqueeSelection } from './useLaunchMarqueeSelection';
import { useOptionalAuth } from '../../auth/AuthContext';
import { LaunchListFilter } from './LaunchListFilter';

import { DeferredLaunchSession, preloadLaunchSession } from './DeferredLaunchSession';
import { prefetchCatalogVideoR2Availability } from '../product-catalog/useCatalogVideoR2Availability';
import { searchWithLayoutFallback } from '../../lib/layoutFallback';

function isOlderLaunchDetail(next: LaunchDetail, current: LaunchDetail | null): boolean {
  if (!current || current.id !== next.id) return false;
  return (
    BigInt(next.version) < BigInt(current.version) ||
    Boolean(
      next.generation &&
      current.generation &&
      next.generation.id === current.generation.id &&
      BigInt(next.generation.stateVersion) < BigInt(current.generation.stateVersion)
    )
  );
}
type ArchiveCandidate = {
  id: string;
  version: string;
  requestKey: string;
  hasCatalog: boolean;
  hasRestitch: boolean;
  suppressed: boolean;
};
type ArchiveTarget = { items: ArchiveCandidate[]; suppress?: boolean };
const BATCH_READ_WAIT_MS = 4_000;
/** How long a launch read ahead of its press is good for. */
const DETAIL_WARM_MS = 8_000;
/** How long the pointer rests on a card before its launch is read ahead. */
const DETAIL_DWELL_MS = 110;
export function LaunchSpace({
  teamId,
  query,
  shown = true
}: {
  teamId: string;
  query: TeamRouteQuery;
  /** False while the section is kept mounted but another one is on screen (058). */
  shown?: boolean;
}) {
  const actorId = useOptionalAuth()?.user?.id ?? null;
  const { can } = useTeam();
  const { t } = useI18n();
  if (!can('view')) return <PermissionState message={t('teamErrorPermissionDenied')} />;
  return (
    <LaunchSpaceContent
      key={`${teamId}:${actorId ?? 'preview'}`}
      teamId={teamId}
      query={query}
      actorId={actorId}
      shown={shown}
    />
  );
}
function LaunchSpaceContent({
  teamId,
  query,
  actorId,
  shown
}: {
  teamId: string;
  query: TeamRouteQuery;
  actorId: string | null;
  shown: boolean;
}) {
  const { t } = useI18n();
  const { revision, can } = useTeam();
  const toasts = useOptionalToasts();
  const [batch, setBatch] = useState<LaunchBatchCommand | null>(null);
  const [batches, setBatches] = useState<DurableLaunchBatch[]>([]);
  const [batchPending, setBatchPending] = useState(false);
  const [batchSubmissionPending, setBatchSubmissionPending] = useState(false);
  const [batchPulse, setBatchPulse] = useState(0);
  const batchRunning = useRef(false);
  const [BatchComponent, setBatchComponent] = useState<typeof LaunchBatch | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [accounts, setAccounts] = useState<TeamAccountSummary[]>([]);
  const [assignees, setAssignees] = useState<Array<{ userId: string; label: string }>>([]);
  const [offers, setOffers] = useState<LaunchDictionaryItem[]>([]);
  const [buyers, setBuyers] = useState<LaunchDictionaryItem[]>([]);
  const [defaults, setDefaults] = useState<Awaited<ReturnType<typeof launchApi.defaults>>>(null);
  const [ready, setReady] = useState(false);
  // The first page of the list has been read (or failed). Until then "no launches yet" would be
  // a lie that flashes before the cards (058, beta feedback).
  const [listLoaded, setListLoaded] = useState(false);
  // The last read of the list failed: what is on screen is not "an empty list".
  const [listFailed, setListFailed] = useState(false);
  // The batch block has read what it shows: it sits above the cards, and arriving later it
  // pushed the whole grid down.
  const [batchesRead, setBatchesRead] = useState(actorId === null);
  // The batch read has its own deadline and retries; the board does not wait past this for it.
  useEffect(() => {
    if (batchesRead) return;
    const timer = window.setTimeout(() => setBatchesRead(true), BATCH_READ_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [batchesRead]);
  const [setupRetry, setSetupRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Awaited<ReturnType<typeof launchApi.list>>['items']>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const launchMarquee = useLaunchMarqueeSelection(items, selectedIds, setSelectedIds);
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveRunning = useRef(false);
  const [archiveSuppress, setArchiveSuppress] = useState(false);
  const bulkAnchor = useRef<HTMLDivElement>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [cursor, setCursor] = useState<{
    id: string;
    date: string | null;
    createdAt?: string;
  } | null>(null);
  const viewKey = (name: string) =>
    persistedViewKey(teamId, `launches.${actorId ?? 'preview'}.${name}`);
  const [search, setSearch] = usePersistedState(viewKey('search'), '', boundedText());
  const [accountFilter, setAccountFilter] = usePersistedState(
    viewKey('account'),
    '',
    boundedText()
  );
  const [assigneeFilter, setAssigneeFilter] = usePersistedState(
    viewKey('assignee'),
    '',
    boundedText()
  );
  const [offerFilter, setOfferFilter] = usePersistedState(viewKey('offer'), '', boundedText());
  const [dates, setDates] = usePersistedState<TaskDateFilter>(
    viewKey('date'),
    { kind: 'all' },
    parseStoredDateFilter,
    encodeDateFilter
  );
  const filterHeadingId = useId();
  const activeListFilterCount =
    Number(Boolean(accountFilter)) + Number(Boolean(offerFilter)) + Number(Boolean(assigneeFilter));
  const resetListCursor = () => {
    listRequest.current++;
    setCursor(null);
  };
  /*
   * A filter changes three things — the toolbar gains or loses a chip, the finished batches
   * step aside, and then the list answers — and each used to land in its own frame: the board
   * jerked up, sideways and then collapsed (owner, beta). They are one move now: the old board
   * stays until the list has answered and the two crossfade.
   */
  const listAnswered = useRef<(() => void) | null>(null);
  const changeFilters = (apply: () => void) => {
    listAnswered.current?.();
    const answered = new Promise<void>(resolve => {
      listAnswered.current = resolve;
    });
    crossfadeLayout(() => {
      resetListCursor();
      apply();
    }, answered);
  };
  const filtersActive =
    Boolean(search.trim() || accountFilter || offerFilter || assigneeFilter) ||
    dates.kind !== 'all';
  const [detail, setDetail] = useState<LaunchDetail | null>(null);
  const detailRead = useRef<{ id: string; revisionId: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const sessionRequest = useRef(0);
  const listRequest = useRef(0);
  const open = query.launchId ?? null;
  const sessionIdentity = useRef({ open, key: crypto.randomUUID() });
  if (sessionIdentity.current.open !== open)
    sessionIdentity.current = { open, key: crypto.randomUUID() };
  const scope = useRef({
    mounted: true,
    teamId,
    actorId,
    open,
    canDelete: can('delete'),
    canEdit: can('edit')
  });
  const closeRequestRef = useRef<() => void>(() => {});
  scope.current.teamId = teamId;
  scope.current.actorId = actorId;
  scope.current.open = open;
  scope.current.canDelete = can('delete');
  scope.current.canEdit = can('edit');
  useEffect(() => {
    scope.current.mounted = true;
    return () => {
      scope.current.mounted = false;
      sessionRequest.current++;
      listRequest.current++;
    };
  }, []);
  const route = (
    id: string | null,
    tab?: 'result' | 'settings',
    revisionId?: string,
    replace = false
  ) =>
    navigateTo(
      buildTeamRoute({
        spaceId: teamId,
        section: 'launches',
        query: {
          ...emptyTeamRouteQuery(),
          launchId: id,
          launchTab: tab ?? null,
          revisionId: revisionId ?? null
        }
      }),
      replace,
      false
    );
  /*
   * A launch that is about to be opened, read ahead (058).
   *
   * The dialog shows only once the launch is read, so a press on a card was a quarter of a
   * second with nothing on screen. The pointer rests on a card before it presses it; the read
   * starts then, and the press finds it done or nearly. One read, used once: whatever opens
   * later reads again.
   */
  const warmDetails = useRef(new Map<string, { at: number; promise: Promise<LaunchDetail> }>());
  const warmDetail = (id: string) => {
    const now = Date.now();
    const hit = warmDetails.current.get(id);
    if (hit && now - hit.at < DETAIL_WARM_MS) return;
    const promise = launchApi.detail(teamId, id, null);
    promise.catch(() => {
      if (warmDetails.current.get(id)?.promise === promise) warmDetails.current.delete(id);
    });
    warmDetails.current.set(id, { at: now, promise });
    for (const [key, value] of warmDetails.current) {
      if (now - value.at >= DETAIL_WARM_MS) warmDetails.current.delete(key);
    }
  };
  const readDetail = (id: string, revisionId: string | null) => {
    const warm = revisionId ? undefined : warmDetails.current.get(id);
    if (warm) {
      warmDetails.current.delete(id);
      if (Date.now() - warm.at < DETAIL_WARM_MS) return warm.promise;
    }
    return launchApi.detail(teamId, id, revisionId);
  };
  const dwell = useRef<number | null>(null);
  const cardUnder = (target: EventTarget | null) =>
    target instanceof Element
      ? (target.closest<HTMLElement>('[data-launch-id]')?.dataset.launchId ?? null)
      : null;
  const usedSearch = useRef('');
  // The editor's code arrives while the board is read, not when a card is opened — and so
  // does the answer the catalog shelf's R2 switch waits for, which otherwise appeared a beat
  // after the shelf (next QA 2026-11-21).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      preloadLaunchSession();
      prefetchCatalogVideoR2Availability(teamId, teamApi.catalogVideoR2);
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [teamId]);
  const readList = useCallback(
    async (next: { id: string; date: string | null; createdAt?: string } | null = null) => {
      const f: {
        search: string;
        accountId?: string;
        assigneeId?: string;
        offerId?: string;
        from?: string;
        to?: string;
        cursorId?: string;
        cursorDate?: string | null;
        cursorCreatedAt?: string;
        sort: string;
      } = { search, sort: 'created' };
      if (accountFilter) f.accountId = accountFilter;
      if (assigneeFilter) f.assigneeId = assigneeFilter;
      if (offerFilter) f.offerId = offerFilter;
      if (dates.kind === 'range') {
        f.from = dates.from;
        f.to = dates.to;
      }
      if (next) {
        f.cursorId = next.id;
        f.cursorDate = next.date;
        if (next.createdAt) f.cursorCreatedAt = next.createdAt;
      }
      const seq = ++listRequest.current;
      // The first page decides the layout; later pages keep the words that found it.
      if (!next) usedSearch.current = search;
      const result = next
        ? await launchApi.list(teamId, { ...f, search: usedSearch.current })
        : await searchWithLayoutFallback(search, async query => {
            const page = await launchApi.list(teamId, { ...f, search: query });
            if (page.items.length > 0) usedSearch.current = query;
            return page;
          });
      if (seq !== listRequest.current) return;
      setItems(old => (next ? [...old, ...result.items] : result.items));
      setCursor(result.nextCursor);
    },
    [teamId, search, accountFilter, assigneeFilter, offerFilter, dates]
  );
  const refresh = useCallback(async () => {
    await readList();
  }, [readList]);
  useEffect(() => {
    let active = true;
    void Promise.all([
      launchApi.accounts(teamId),
      teamApi.listAssignees(teamId),
      launchApi.dictionaries(teamId),
      launchApi.defaults(teamId)
    ])
      .then(([a, members, d, defs]) => {
        if (!active) return;
        setAccounts(a);
        setAssignees(
          members.map(member => ({
            userId: member.userId,
            label: member.displayName ?? t('teamMemberUnnamed')
          }))
        );
        setAssigneeFilter(current => {
          if (!current || members.some(member => member.userId === current)) return current;
          listRequest.current++;
          setCursor(null);
          return '';
        });
        setOffers(d.offers);
        setBuyers(d.buyers);
        setDefaults(defs);
        setReady(true);
      })
      .catch(e => {
        if (active) setError(teamErrorMessageFor(e, t));
      });
    return () => {
      active = false;
    };
  }, [teamId, t, revision, setupRetry]);
  useEffect(() => {
    // The read that answers the filter change waiting on it — not one already under way.
    const waiting = listAnswered.current;
    void refresh()
      .then(() => setListFailed(false))
      .catch(e => {
        setListFailed(true);
        setError(teamErrorMessageFor(e, t));
      })
      .finally(() => {
        setListLoaded(true);
        if (waiting && listAnswered.current === waiting) {
          listAnswered.current = null;
          waiting();
        }
      });
  }, [refresh, revision, t]);
  const hasRunningLaunch =
    batchPending || items.some(item => ['running', 'queued'].includes(launchCardState(item)));
  useEffect(() => {
    // Out of sight the board is not watched on a clock; live signals still reach it, and the
    // clock starts again when it is shown.
    if (!hasRunningLaunch || !shown) return;
    const reconcile = () => {
      // Observe durable work with the existing workspace cadence, independent of list filters.
      setBatchPulse(value => value + 1);
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    };
    const timer = window.setInterval(reconcile, 10_000);
    document.addEventListener('visibilitychange', reconcile);
    window.addEventListener('focus', reconcile);
    window.addEventListener('online', reconcile);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', reconcile);
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('online', reconcile);
    };
  }, [hasRunningLaunch, refresh, shown]);
  useEffect(() => {
    const seq = ++sessionRequest.current;
    if (!open || open === 'new') {
      detailRead.current = null;
      setDetail(null);
      // A read still in flight for the Launch just closed is now someone else's sequence
      // and never clears this: «Готуємо запуск…» stayed over the list for good (next,
      // 2026-11-21, closing a Launch right after its generation).
      setPending(false);
      return;
    }
    setPending(true);
    void readDetail(open, query.revisionId ?? null)
      .then(d => {
        if (seq === sessionRequest.current) {
          const sameRevision = detailRead.current?.revisionId === (query.revisionId ?? null);
          detailRead.current = { id: open, revisionId: query.revisionId ?? null };
          setDetail(current => (sameRevision && isOlderLaunchDetail(d, current) ? current : d));
          setPending(false);
        }
      })
      .catch(e => {
        if (seq === sessionRequest.current) {
          // Only a permanent refusal closes the open Launch. A slow or overloaded
          // server keeps the dialog (and its running generation) on screen (1.4.3).
          if (e instanceof TeamApiError && !e.retryable) {
            detailRead.current = null;
            setDetail(null);
          }
          setError(
            e instanceof TeamApiError && e.retryable && e.code === 'TEAM_TRANSPORT_UNAVAILABLE'
              ? t('catalogServerSlow')
              : teamErrorMessageFor(e, t)
          );
          setPending(false);
        }
      });
  }, [teamId, open, query.revisionId, revision, t]);
  const changed = (next: LaunchDetail, tab?: 'result' | 'settings') => {
    if (
      !scope.current.mounted ||
      scope.current.teamId !== teamId ||
      scope.current.actorId !== actorId ||
      scope.current.open !== open
    )
      return;
    // Adopting our just-saved draft is the same editing session. Copying or
    // opening another existing Launch gets a new session and fresh RAM state.
    if (open === 'new') sessionIdentity.current.open = next.id;
    sessionRequest.current++;
    detailRead.current = { id: next.id, revisionId: null };
    setDetail(current => (isOlderLaunchDetail(next, current) ? current : next));
    if (open !== next.id || tab)
      route(next.id, tab ?? (next.activeRevision ? 'result' : 'settings'));
    void refresh();
  };
  const executeArchive = (target: ArchiveTarget, suppressWarning: boolean) => {
    if (archiveRunning.current || !scope.current.mounted || !scope.current.canDelete) return;
    archiveRunning.current = true;
    const suppress = target.suppress ?? suppressWarning;
    if (archiveTarget) setArchiveTarget({ ...target, suppress });
    setArchiveBusy(true);
    void (async () => {
      for (const item of target.items) {
        await launchMutation({ flowId: item.requestKey, launchId: item.id }, 'archive_launch', () =>
          launchApi.archive(teamId, item.id, item.version, item.requestKey, suppress)
        );
      }
    })()
      .then(() => {
        if (!scope.current.mounted) return;
        setArchiveTarget(null);
        setSelectedIds(previous => {
          const next = new Set(previous);
          for (const item of target.items) next.delete(item.id);
          return next;
        });
        void refresh().catch(e => {
          if (!scope.current.mounted) return;
          setError(teamErrorMessageFor(e, t));
        });
      })
      .catch(e => {
        if (!scope.current.mounted) return;
        setArchiveTarget({ ...target, suppress });
        setError(teamErrorMessageFor(e, t));
      })
      .finally(() => {
        archiveRunning.current = false;
        if (scope.current.mounted) setArchiveBusy(false);
      });
  };
  const requestArchive = (targets: ArchiveCandidate[]) => {
    if (!targets.length || !scope.current.mounted || !scope.current.canDelete) return;
    if (targets.every(item => item.suppressed)) executeArchive({ items: targets }, true);
    else {
      setArchiveSuppress(false);
      setArchiveTarget({ items: targets });
    }
  };
  const deleteSelected = () => {
    if (!can('delete') || archiveBusy) return;
    const rows = items.filter(i => selectedIds.has(i.id));
    if (rows.some(i => launchInputsLocked(i.generationState)) || rows.length === 0) return;
    void Promise.all(
      rows.map(async item => ({
        id: item.id,
        version: item.version,
        requestKey: crypto.randomUUID(),
        ...(await launchApi.archiveWarning(teamId, item.id))
      }))
    )
      .then(requestArchive)
      .catch(e => setError(teamErrorMessageFor(e, t)));
  };
  const selection = useLaunchListSelection({
    teamId,
    items,
    selected: selectedIds,
    setSelected: setSelectedIds,
    open: Boolean(open),
    editable: can('edit'),
    onDelete: deleteSelected,
    onChanged: () => {
      void refresh().catch(e => setError(teamErrorMessageFor(e, t)));
    },
    onError: e => setError(teamErrorMessageFor(e, t)),
    onCopied: () => toasts?.push({ tone: 'success', text: t('launchesBulkSelectedCopied') })
  });
  const eligible = items.filter(i => selectedIds.has(i.id) && batchEligible(i));
  // Restore server-owned batches on re-entry, even before the next Generate click.
  useEffect(() => {
    if (!actorId) return;
    let live = true;
    const epoch = privateCacheActorEpoch();
    void import('./LaunchBatch.js')
      .then(module => {
        if (live && scope.current.mounted && epoch === privateCacheActorEpoch())
          setBatchComponent(() => module.LaunchBatch);
      })
      .catch(() => {
        if (live) setError(t('genericError'));
      });
    return () => {
      live = false;
    };
  }, [actorId, t]);
  const startBatch = async () => {
    if (eligible.length > LAUNCH_BATCH_MAX_ITEMS) {
      setError(t('launchesBulkLimit'));
      return;
    }
    if (!eligible.length) return;
    const selected = [...eligible].sort((a, b) =>
      (a.sourceMaterialId ?? a.id).localeCompare(b.sourceMaterialId ?? b.id)
    );
    await submitBatch(
      selected.map(row => ({ id: row.id, version: row.version, method: row.method })),
      crypto.randomUUID()
    );
  };
  /**
   * The one way a batch starts: the selection's «Згенерувати» and the assistant's «Запустити N»
   * (064) both hand over exact rows with the versions they showed; the batch refuses a changed one.
   */
  const submitBatch = async (
    selected: Array<{ id: string; version: string; method: 'catalog' | 'other' }>,
    id: string
  ) => {
    if (batchRunning.current || batchSubmissionPending || !can('edit') || !actorId) return;
    const ownerEpoch = privateCacheActorEpoch();
    const current = () =>
      scope.current.mounted && scope.current.canEdit && ownerEpoch === privateCacheActorEpoch();
    batchRunning.current = true;
    setBatchLoading(true);
    launchBatchLoading(id, 'started');
    try {
      let executorId = recoveryInstallation();
      if (selected.some(row => row.method === 'catalog')) {
        try {
          const status = await ensureBackgroundRecovery(teamId, {
            actorId,
            isCurrent: current,
            resumeBlockedWork: true,
            onSetupStage: observeBackgroundSetup
          });
          if (status.enabled) executorId = status.installationId;
        } catch {
          // Existing authorized background ownership may outlive this connection.
          // The server validates it independently and retains affected items for recovery.
        }
      }
      const module = await import('./LaunchBatch.js');
      if (!current()) {
        launchBatchLoading(id, 'cancelled');
        batchRunning.current = false;
        return;
      }
      setBatchComponent(() => module.LaunchBatch);
      setBatch({
        teamId,
        expectedActorId: actorId,
        requestKey: id,
        items: selected.map(row => ({
          launchId: row.id,
          expectedVersion: row.version,
          childRequestKey: crypto.randomUUID()
        })),
        ...(executorId ? { expectedExecutorId: executorId } : {})
      });
      launchBatchLoading(id, 'loaded');
    } catch {
      launchBatchLoading(id, 'failed');
      batchRunning.current = false;
      if (current()) setError(t('genericError'));
    } finally {
      if (scope.current.mounted) setBatchLoading(false);
    }
  };
  const batchItemFor = (id: string) =>
    batches.flatMap(value => value.items).find(item => item.launchId === id);
  const visibleDetail =
    detail?.id === open &&
    detailRead.current?.id === open &&
    detailRead.current.revisionId === (query.revisionId ?? null)
      ? detail
      : null;
  // 064: the space's assistant starts batches here and asks the list to read again after a change.
  const assistantRun = useRef<
    (rows: Array<{ launchId: string; version: string }>, key: string) => Promise<void>
  >(async () => {});
  assistantRun.current = async (rows, batchKey) => {
    const known = new Map(items.map(item => [item.id, item.method]));
    await submitBatch(
      rows.map(row => ({
        id: row.launchId,
        version: row.version,
        method: known.get(row.launchId) ?? 'catalog'
      })),
      batchKey
    );
  };
  useEffect(
    () => registerLaunchRunner(teamId, (rows, key) => assistantRun.current(rows, key)),
    [teamId]
  );
  useEffect(
    () =>
      onLaunchesChanged(changed => {
        if (changed === teamId) void refresh().catch(e => setError(teamErrorMessageFor(e, t)));
      }),
    [teamId, refresh, t]
  );
  // Everything the board shows first, read before any of it is shown (058): the cards, the
  // dictionaries their labels come from, and the batch block above them.
  const busy = !error && (!ready || !listLoaded || (Boolean(actorId) && !batchesRead));
  return (
    <section
      className="team-panel team-launch-space flex min-w-0 flex-col gap-4"
      aria-label={t('launchesTitle')}
      onPointerDown={launchMarquee.onPointerDown}
    >
      {/*
       * The list's toolbar (070, T080): search, the date, «Фільтри», and the one primary. On a
       * phone it is two rows and no more — the search, then the date, «Фільтри» and «Новий
       * запуск» — with "Вчора / Сьогодні / Завтра" folded into the calendar's presets, where the
       * calendar glyph used to stand alone on a row of its own.
       */}
      {/* The selection bar takes this row's place while launches are selected — the explorer's
          way (070, phase 9ж). The row stays laid out under it, unseen and inert, so the bar has
          exactly its height and a rectangle's launch is never pushed out from under it. */}
      <div className={`team-board-controls${selectedIds.size > 0 ? ' is-selecting' : ''}`}>
        <div className="launch-list-toolbar" inert={selectedIds.size > 0 ? true : undefined}>
          <SearchField
            className="launch-list-search"
            aria-label={t('launchesSearch')}
            placeholder={t('launchesSearch')}
            clearLabel={t('teamSearchClear')}
            value={search}
            onChange={next => changeFilters(() => setSearch(next))}
          />
          <TaskDateFilterControl
            value={dates}
            onChange={next => changeFilters(() => setDates(next))}
            status="all"
            onStatusChange={() => {}}
            showStatus={false}
            inlineDays
            inlineTomorrow
            size="sm"
          >
            <TaskFiltersButton count={activeListFilterCount} size="sm">
              <div
                className="task-filter-section"
                role="group"
                aria-labelledby={`${filterHeadingId}-show`}
              >
                <span id={`${filterHeadingId}-show`} className="task-filter-heading">
                  {t('teamTasksFilterGroup')}
                </span>
                <LaunchListFilter
                  label={t('launchesFilterAccount')}
                  allLabel={t('launchesFilterAllAccounts')}
                  value={accountFilter}
                  onChange={next => changeFilters(() => setAccountFilter(next))}
                  options={accounts
                    .map(account => ({ value: account.id, label: account.name }))
                    .sort((a, b) => a.label.localeCompare(b.label))}
                />
                <LaunchListFilter
                  label={t('launchesOffer')}
                  allLabel={t('launchesAllOffers')}
                  value={offerFilter}
                  onChange={next => changeFilters(() => setOfferFilter(next))}
                  options={offers
                    .map(offer => ({ value: offer.id, label: offer.value }))
                    .sort((a, b) => a.label.localeCompare(b.label))}
                />
                <LaunchListFilter
                  label={t('launchesFilterAssignee')}
                  allLabel={t('launchesFilterAllAssignees')}
                  value={assigneeFilter}
                  onChange={next => changeFilters(() => setAssigneeFilter(next))}
                  options={assignees
                    .map(member => ({ value: member.userId, label: member.label }))
                    .sort((a, b) => a.label.localeCompare(b.label))}
                />
              </div>
            </TaskFiltersButton>
          </TaskDateFilterControl>
          {can('edit') && (
            <Button
              type="button"
              className="launch-list-new"
              variant={selectedIds.size ? 'outline' : 'primary'}
              onClick={() => route('new', 'settings')}
            >
              <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('launchesNew')}
            </Button>
          )}
        </div>
        {selectedIds.size > 0 && (
          <SelectionBar
            className="team-board-selection-bar"
            count={selectedIds.size}
            label={t('teamTaskSelectedCount', { count: selectedIds.size })}
            clearLabel={t('teamTaskClearSelection', { count: selectedIds.size })}
            onClear={() => setSelectedIds(new Set())}
            actions={
              /* The batch's three acts on the bar, the rarer ones under "…" — the explorer's
                 way. The words go on a narrow bar (CSS only); the names stay. */
              <div ref={bulkAnchor} className="team-task-bulk">
                {can('edit') && (
                  <Button
                    size="sm"
                    variant="primary"
                    className="team-board-selection-act"
                    aria-label={t('launchesBulkGenerate', { count: eligible.length })}
                    disabled={!eligible.length || batchSubmissionPending || batchLoading}
                    title={!eligible.length ? t('launchesBulkDraftsOnly') : undefined}
                    loading={batchLoading}
                    leading={<Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
                    onClick={() => void startBatch()}
                  >
                    <span className="team-board-selection-act-label">
                      {t('launchesBulkGenerate', { count: eligible.length })}
                    </span>
                  </Button>
                )}
                <Button
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  className="team-board-selection-act"
                  aria-label={t('launchesBulkCopy', { count: selectedIds.size })}
                  disabled={selection.busy}
                  leading={<Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
                  onClick={selection.copySelected}
                >
                  <span className="team-board-selection-act-label">
                    {t('launchesBulkCopy', { count: selectedIds.size })}
                  </span>
                </Button>
                {can('delete') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    color="error"
                    className="team-board-selection-act"
                    aria-label={t('launchesArchiveSelected', { count: selectedIds.size })}
                    disabled={
                      archiveBusy ||
                      items.some(
                        i => selectedIds.has(i.id) && launchInputsLocked(i.generationState)
                      )
                    }
                    leading={
                      <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    }
                    onClick={deleteSelected}
                  >
                    <span className="team-board-selection-act-label">
                      {t('launchesArchiveSelected', { count: selectedIds.size })}
                    </span>
                  </Button>
                )}
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={t('teamTaskBulkActions')}
                  title=""
                  aria-haspopup="menu"
                  aria-expanded={bulkOpen}
                  onClick={() => setBulkOpen(current => !current)}
                >
                  <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </IconButton>
                <DropdownMenu
                  open={bulkOpen}
                  onClose={() => setBulkOpen(false)}
                  anchor={bulkAnchor}
                  placement="bottom-end"
                  label={t('teamTaskBulkActions')}
                  items={[
                    /* "All loaded" belongs to a selection that has begun (070 T069). */
                    ...(selectedIds.size < items.length
                      ? [
                          {
                            id: 'select-loaded',
                            label: t('launchesBulkSelectAll'),
                            icon: (
                              <ListChecks
                                size={ICON_SIZE}
                                strokeWidth={ICON_STROKE}
                                aria-hidden="true"
                              />
                            ),
                            onSelect: () => {
                              setSelectedIds(new Set(items.map(i => i.id)));
                              setBulkOpen(false);
                            }
                          }
                        ]
                      : []),
                    {
                      id: 'copy-links',
                      label: t('launchesCopySelectedLinks'),
                      icon: <Link2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
                      onSelect: () => {
                        const links = items
                          .filter(item => selectedIds.has(item.id))
                          .map(item => {
                            const path = buildTeamRoute({
                              spaceId: teamId,
                              section: 'launches',
                              query: { ...emptyTeamRouteQuery(), launchId: item.id }
                            });
                            return new URL(path, window.location.origin).href;
                          });
                        void navigator.clipboard.writeText(links.join('\n')).catch(() => {
                          setError(t('launchesCopyFailed'));
                        });
                        setBulkOpen(false);
                      }
                    }
                  ]}
                />
              </div>
            }
          />
        )}
      </div>
      {/* The error pattern (070, T080): the sentence, and — when the list could not even be set
          up — the retry inside it rather than a loose button under it. */}
      {error && (
        <ErrorState
          className="team-inline-error"
          message={error}
          onRetry={!ready ? () => setSetupRetry(n => n + 1) : undefined}
          retryLabel={t('retry')}
        />
      )}
      {pending && !open && <p role="status">{t('launchesBusy')}</p>}
      <Reveal
        busy={busy}
        className="flex min-w-0 flex-col gap-4"
        placeholder={
          <Skeleton
            shape="tile"
            count={8}
            label={t('launchesBusy')}
            className="team-task-grid launch-grid"
          />
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-label text-ink-muted">
          <span>{t('launchesBulkNewest')}</span>
          {selection.canPaste && can('edit') && (
            <Button
              size="sm"
              variant="outline"
              disabled={selection.busy}
              onClick={() => void selection.paste()}
            >
              {t('launchesBulkPaste', { count: selection.pasteCount })}
            </Button>
          )}
        </div>
        {batchLoading && <LoadingState shape="block" count={1} label={t('launchesBusy')} />}
        {actorId && BatchComponent && (
          <BatchComponent
            key={`${teamId}:${actorId}:${privateCacheActorEpoch()}`}
            teamId={teamId}
            actorId={actorId}
            command={batch}
            reconcileEpoch={batchPulse + revision}
            enabled={can('edit')}
            onBatches={setBatches}
            onInitialRead={() => setBatchesRead(true)}
            showSettled={!filtersActive}
            onPendingChange={setBatchPending}
            onSubmissionPendingChange={pending => {
              setBatchSubmissionPending(pending);
              batchRunning.current = pending;
            }}
            onSubmitted={key => {
              setBatch(current => (current?.requestKey === key ? null : current));
              batchRunning.current = false;
            }}
            onChange={() => {
              void refresh().catch(e => setError(teamErrorMessageFor(e, t)));
            }}
            onOpen={id => route(id, 'result')}
          />
        )}
        <div
          className="team-task-grid launch-grid"
          onPointerDown={event => {
            const id = cardUnder(event.target);
            if (id) warmDetail(id);
          }}
          onPointerOver={event => {
            const id = cardUnder(event.target);
            if (dwell.current !== null) window.clearTimeout(dwell.current);
            dwell.current = id ? window.setTimeout(() => warmDetail(id), DETAIL_DWELL_MS) : null;
          }}
          onPointerLeave={() => {
            if (dwell.current !== null) window.clearTimeout(dwell.current);
            dwell.current = null;
          }}
        >
          {items.map(value => (
            <LaunchCard
              key={value.id}
              value={durableCardValue(value, batchItemFor(value.id))}
              onOpen={() => route(value.id)}
              selected={selectedIds.has(value.id)}
              onSelectedChange={(selected, modifiers) =>
                selection.select(value.id, selected, modifiers?.shiftKey)
              }
              queueState={(() => {
                const item = batchItemFor(value.id);
                if (!item || (value.generation && value.generation.id !== item.generationId))
                  return undefined;
                if (
                  value.generation &&
                  item.generation &&
                  BigInt(value.generation.stateVersion) > BigInt(item.generation.stateVersion)
                )
                  return undefined;
                if (!value.generation && value.version !== item.expectedVersion) return undefined;
                return durableItemState(item);
              })()}
              onCopyLink={() => {
                const path = buildTeamRoute({
                  spaceId: teamId,
                  section: 'launches',
                  query: { ...emptyTeamRouteQuery(), launchId: value.id }
                });
                void navigator.clipboard
                  .writeText(new URL(path, window.location.origin).href)
                  .catch(() => setError(t('launchesCopyFailed')));
              }}
              onDelete={
                can('delete')
                  ? () => {
                      void launchApi
                        .archiveWarning(teamId, value.id)
                        .then(warning => {
                          requestArchive([
                            {
                              id: value.id,
                              version: value.version,
                              requestKey: crypto.randomUUID(),
                              hasCatalog: warning.hasCatalog,
                              hasRestitch: warning.hasRestitch,
                              suppressed: warning.suppressed
                            }
                          ]);
                        })
                        .catch(e => setError(teamErrorMessageFor(e, t)));
                    }
                  : undefined
              }
              actionsDisabled={archiveBusy || launchInputsLocked(value.generationState)}
            />
          ))}
        </div>
        {archiveTarget && (
          <Modal title={t('launchesArchive')} onClose={() => setArchiveTarget(null)}>
            <div className="flex flex-col gap-3 p-4">
              {archiveTarget.items.some(item => item.hasCatalog || item.hasRestitch) && (
                <p>
                  {t(
                    archiveTarget.items.some(item => item.hasRestitch)
                      ? 'launchesRetentionVideo'
                      : 'launchesRetention'
                  )}
                </p>
              )}
              <Checkbox
                label={t('launchesSuppress')}
                checked={archiveSuppress}
                onChange={setArchiveSuppress}
                disabled={archiveBusy || archiveTarget.suppress !== undefined}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  disabled={archiveBusy}
                  onClick={() => setArchiveTarget(null)}
                >
                  {t('teamCancel')}
                </Button>
                <Button
                  variant="danger"
                  disabled={archiveBusy}
                  onClick={() => {
                    executeArchive(archiveTarget, archiveSuppress);
                  }}
                >
                  {t('launchesArchive')}
                </Button>
              </div>
            </div>
          </Modal>
        )}
        {/* Not under an error: "no launches yet" below "the server answered unexpectedly"
            said the list was read and empty when it had not been read at all. */}
        {ready && !items.length && !listFailed && (
          /* The empty pattern (070, T080): one sentence, and the way out of it as the action. */
          <EmptyState
            size="sm"
            title={t(filtersActive ? 'launchesFilterEmpty' : 'launchesEmpty')}
            action={
              filtersActive && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    changeFilters(() => {
                      setSearch('');
                      setAccountFilter('');
                      setAssigneeFilter('');
                      setOfferFilter('');
                      setDates({ kind: 'all' });
                    })
                  }
                >
                  {t('launchesFiltersClearAll')}
                </Button>
              )
            }
          />
        )}
        {cursor && (
          <Button
            color="neutral"
            onClick={() => void readList(cursor).catch(e => setError(teamErrorMessageFor(e, t)))}
          >
            {t('teamExplorerLoadMore')}
          </Button>
        )}
      </Reveal>
      {open && ready && (open === 'new' || visibleDetail) && (
        <Modal
          labelledBy="team-launch-dialog-title"
          size="xl"
          onClose={() => closeRequestRef.current()}
          className={`team-launch-modal${
            (query.launchTab ??
              (visibleDetail?.activeRevision || visibleDetail?.generation
                ? 'result'
                : 'settings')) === 'result'
              ? ' team-launch-modal--result'
              : ''
          }`}
        >
          <h2 id="team-launch-dialog-title" className="visually-hidden">
            {t('launchesTitle')}
          </h2>
          <DeferredLaunchSession
            key={`${teamId}:${actorId ?? 'preview'}:${sessionIdentity.current.key}`}
            teamId={teamId}
            detail={open === 'new' ? null : visibleDetail}
            initialMaterialId={open === 'new' ? query.launchMaterialId : null}
            defaults={defaults}
            accounts={accounts}
            offers={offers}
            buyers={buyers}
            editable={can('edit')}
            manage={can('manage_metadata')}
            deletable={can('delete')}
            tab={
              query.launchTab ??
              (visibleDetail?.activeRevision || visibleDetail?.generation ? 'result' : 'settings')
            }
            revisionId={query.revisionId ?? null}
            onTab={(tab, replace) => route(open, tab, undefined, replace)}
            refusedCode={
              open === 'new'
                ? null
                : batchItemFor(open)?.admission === 'refused'
                  ? (batchItemFor(open)?.errorCode ?? 'UNKNOWN')
                  : null
            }
            onRevision={id => route(open, 'result', id)}
            historical={Boolean(query.revisionId)}
            onChange={changed}
            onClose={() => route(null)}
            closeRequestRef={closeRequestRef}
            onDictionaries={async () => {
              const d = await launchApi.dictionaries(teamId);
              if (
                !scope.current.mounted ||
                scope.current.teamId !== teamId ||
                scope.current.actorId !== actorId
              )
                return;
              setOffers(d.offers);
              setBuyers(d.buyers);
            }}
          />
        </Modal>
      )}
    </section>
  );
}
