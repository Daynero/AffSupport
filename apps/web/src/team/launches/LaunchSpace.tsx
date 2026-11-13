import { privateCacheActorEpoch } from '../private-cache-scope.js';
import type { LaunchBatch } from './LaunchBatch.js';
import { launchCardState } from './launchPresentation.js';
import {
  batchCardState,
  batchEligible,
  planLaunchBatch,
  type LaunchBatchItem
} from './batchModel.js';
import { useLaunchListSelection } from './useLaunchListSelection.js';
import { useOptionalToasts } from '../../components/toast';
import { launchBatchLoading, launchMutation } from './analytics';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Copy, Play, Link2, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import {
  LAUNCH_BATCH_MAX_ITEMS,
  launchInputsLocked,
  type LaunchDetail,
  type TeamAccountSummary
} from '@video-compressor/shared';
import { launchApi, teamApi, TeamApiError } from '../../api/team';
import type { LaunchDictionaryItem } from '../../api/launches';
import {
  Button,
  Checkbox,
  DropdownMenu,
  Input,
  Modal,
  Popover,
  SelectionBar,
  LoadingState
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { buildTeamRoute, emptyTeamRouteQuery, type TeamRouteQuery } from '../routes';
import { navigateTo } from '../../lib/navigation';
import { TaskDateFilterControl } from '../tasks/TaskDateFilter';
import { encodeDateFilter, parseStoredDateFilter, type TaskDateFilter } from '../tasks/useTasks';
import { boundedText, persistedViewKey, usePersistedState } from '../persistedView';
import { LaunchCard } from './LaunchCard';
import { useLaunchMarqueeSelection } from './useLaunchMarqueeSelection';
import { useOptionalAuth } from '../../auth/AuthContext';
import { LaunchListFilter } from './LaunchListFilter';

import { DeferredLaunchSession } from './DeferredLaunchSession';

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
export function LaunchSpace({ teamId, query }: { teamId: string; query: TeamRouteQuery }) {
  const actorId = useOptionalAuth()?.user?.id ?? null;
  const { can } = useTeam();
  const { t } = useI18n();
  if (!can('view')) return <p role="alert">{t('teamErrorPermissionDenied')}</p>;
  return (
    <LaunchSpaceContent
      key={`${teamId}:${actorId ?? 'preview'}`}
      teamId={teamId}
      query={query}
      actorId={actorId}
    />
  );
}
function LaunchSpaceContent({
  teamId,
  query,
  actorId
}: {
  teamId: string;
  query: TeamRouteQuery;
  actorId: string | null;
}) {
  const { t } = useI18n();
  const { revision, can } = useTeam();
  const toasts = useOptionalToasts();
  const [batch, setBatch] = useState<{ id: string; items: LaunchBatchItem[] } | null>(null);
  const [batchStates, setBatchStates] = useState<LaunchBatchItem[]>([]);
  const batchRunning = useRef(false);
  const [BatchComponent, setBatchComponent] = useState<typeof LaunchBatch | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [accounts, setAccounts] = useState<TeamAccountSummary[]>([]);
  const [assignees, setAssignees] = useState<Array<{ userId: string; label: string }>>([]);
  const [offers, setOffers] = useState<LaunchDictionaryItem[]>([]);
  const [buyers, setBuyers] = useState<LaunchDictionaryItem[]>([]);
  const [defaults, setDefaults] = useState<Awaited<ReturnType<typeof launchApi.defaults>>>(null);
  const [ready, setReady] = useState(false);
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
  const filtersRoot = useRef<HTMLDivElement | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterHeadingId = useId();
  const activeListFilterCount =
    Number(Boolean(accountFilter)) + Number(Boolean(offerFilter)) + Number(Boolean(assigneeFilter));
  const resetListCursor = () => {
    listRequest.current++;
    setCursor(null);
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
  const route = (id: string | null, tab?: 'result' | 'settings', revisionId?: string) =>
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
      false,
      false
    );
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
      const result = await launchApi.list(teamId, f);
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
    void refresh().catch(e => setError(teamErrorMessageFor(e, t)));
  }, [refresh, revision, t]);
  const hasRunningLaunch =
    batchStates.some(i => ['dispatching', 'accepted', 'uncertain'].includes(i.state)) ||
    items.some(item => ['running', 'queued'].includes(launchCardState(item)));
  useEffect(() => {
    if (!hasRunningLaunch) return;
    const reconcile = () => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    };
    const timer = window.setInterval(reconcile, 10_000);
    document.addEventListener('visibilitychange', reconcile);
    window.addEventListener('focus', reconcile);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', reconcile);
      window.removeEventListener('focus', reconcile);
    };
  }, [hasRunningLaunch, refresh]);
  useEffect(() => {
    const seq = ++sessionRequest.current;
    if (!open || open === 'new') {
      detailRead.current = null;
      setDetail(null);
      return;
    }
    setPending(true);
    void launchApi
      .detail(teamId, open, query.revisionId ?? null)
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
  const startBatch = async () => {
    if (batchRunning.current || !can('edit')) return;
    if (eligible.length > LAUNCH_BATCH_MAX_ITEMS) {
      setError(t('launchesBulkLimit'));
      return;
    }
    const planned = planLaunchBatch(eligible);
    if (!planned.length) return;
    batchRunning.current = true;
    setBatchStates(planned);
    const id = crypto.randomUUID();
    const ownerEpoch = privateCacheActorEpoch();
    setBatchLoading(true);
    launchBatchLoading(id, 'started');
    try {
      const module = await import('./LaunchBatch.js');
      if (
        !scope.current.mounted ||
        !scope.current.canEdit ||
        ownerEpoch !== privateCacheActorEpoch()
      ) {
        launchBatchLoading(id, 'cancelled');
        batchRunning.current = false;
        if (scope.current.mounted) setBatchStates([]);
        return;
      }
      setBatchComponent(() => module.LaunchBatch);
      setBatch({ id, items: planned });
      launchBatchLoading(id, 'loaded');
    } catch {
      launchBatchLoading(id, 'failed');
      batchRunning.current = false;
      if (scope.current.mounted) {
        setBatchStates([]);
        setError(t('genericError'));
      }
    } finally {
      if (scope.current.mounted) setBatchLoading(false);
    }
  };
  const visibleDetail =
    detail?.id === open &&
    detailRead.current?.id === open &&
    detailRead.current.revisionId === (query.revisionId ?? null)
      ? detail
      : null;
  return (
    <section
      className="team-panel team-launch-space flex min-w-0 flex-col gap-4"
      aria-label={t('launchesTitle')}
    >
      <div className="launch-list-toolbar flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-56">
          <Input
            aria-label={t('launchesSearch')}
            placeholder={t('launchesSearch')}
            value={search}
            onChange={e => {
              resetListCursor();
              setSearch(e.target.value);
            }}
          />
        </div>
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <TaskDateFilterControl
            value={dates}
            onChange={next => {
              resetListCursor();
              setDates(next);
            }}
            status="all"
            onStatusChange={() => {}}
            showStatus={false}
            inlineDays
            inlineTomorrow
          >
            <div ref={filtersRoot} className="task-filter-more">
              <button
                type="button"
                className={`task-quick-range${activeListFilterCount > 0 ? ' is-active' : ''}`}
                aria-expanded={filtersOpen}
                aria-label={
                  activeListFilterCount > 0
                    ? t('teamTasksMoreFiltersActive', { count: activeListFilterCount })
                    : undefined
                }
                onClick={() => setFiltersOpen(current => !current)}
              >
                <SlidersHorizontal size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                <span>{t('teamTasksMoreFilters')}</span>
                {activeListFilterCount > 0 && (
                  <span className="task-filter-more-count" aria-hidden="true">
                    {activeListFilterCount}
                  </span>
                )}
              </button>
              <Popover
                open={filtersOpen}
                onClose={() => setFiltersOpen(false)}
                anchor={filtersRoot}
                placement="bottom-start"
                frequent
                label={t('teamTasksMoreFilters')}
                className="task-filter-more-popover"
              >
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
                    onChange={next => {
                      resetListCursor();
                      setAccountFilter(next);
                    }}
                    options={accounts
                      .map(account => ({ value: account.id, label: account.name }))
                      .sort((a, b) => a.label.localeCompare(b.label))}
                  />
                  <LaunchListFilter
                    label={t('launchesOffer')}
                    allLabel={t('launchesAllOffers')}
                    value={offerFilter}
                    onChange={next => {
                      resetListCursor();
                      setOfferFilter(next);
                    }}
                    options={offers
                      .map(offer => ({ value: offer.id, label: offer.value }))
                      .sort((a, b) => a.label.localeCompare(b.label))}
                  />
                  <LaunchListFilter
                    label={t('launchesFilterAssignee')}
                    allLabel={t('launchesFilterAllAssignees')}
                    value={assigneeFilter}
                    onChange={next => {
                      resetListCursor();
                      setAssigneeFilter(next);
                    }}
                    options={assignees
                      .map(member => ({ value: member.userId, label: member.label }))
                      .sort((a, b) => a.label.localeCompare(b.label))}
                  />
                </div>
              </Popover>
            </div>
          </TaskDateFilterControl>
        </div>
        {can('edit') && (
          <Button
            type="button"
            variant={selectedIds.size ? 'outline' : 'primary'}
            onClick={() => route('new', 'settings')}
          >
            <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('launchesNew')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-error-text">
          {error}
        </p>
      )}
      {!ready && error && <Button onClick={() => setSetupRetry(n => n + 1)}>{t('retry')}</Button>}
      {pending && !open && <p role="status">{t('launchesBusy')}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-label text-ink-muted">
        <span>{t('launchesBulkNewest')}</span>
        <div className="flex gap-2">
          {items.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedIds(new Set(items.map(i => i.id)))}
            >
              {t('launchesBulkSelectAll')}
            </Button>
          )}
          {selection.canPaste && can('edit') && (
            <Button
              size="sm"
              variant="outline"
              disabled={selection.busy}
              onClick={() => void selection.paste()}
            >
              {t('launchesBulkPaste')}
            </Button>
          )}
        </div>
      </div>
      {batchLoading && <LoadingState shape="block" count={1} label={t('launchesBusy')} />}
      {batch && BatchComponent && (
        <BatchComponent
          key={batch.id}
          batchId={batch.id}
          teamId={teamId}
          initial={batch.items}
          summaries={items}
          enabled={can('edit')}
          onStates={setBatchStates}
          onFinished={() => {
            batchRunning.current = false;
          }}
          onChange={() => {
            void refresh().catch(e => setError(teamErrorMessageFor(e, t)));
          }}
          onOpen={id => route(id, 'result')}
        />
      )}
      <SelectionBar
        count={selectedIds.size}
        label={t('teamTaskSelectedCount', { count: selectedIds.size })}
        clearLabel={t('teamTaskClearSelection', { count: selectedIds.size })}
        onClear={() => setSelectedIds(new Set())}
        actions={
          <div ref={bulkAnchor} className="team-task-bulk flex flex-wrap gap-2">
            {can('edit') && (
              <Button
                size="sm"
                variant="primary"
                disabled={!eligible.length || batchRunning.current}
                title={!eligible.length ? t('launchesBulkDraftsOnly') : undefined}
                loading={batchLoading}
                onClick={() => void startBatch()}
              >
                <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('launchesBulkGenerate', { count: eligible.length })}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={selection.busy}
              onClick={selection.copySelected}
            >
              <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('launchesBulkCopy')}
            </Button>
            {can('delete') && (
              <Button
                size="sm"
                variant="ghost"
                color="error"
                disabled={
                  archiveBusy ||
                  items.some(i => selectedIds.has(i.id) && launchInputsLocked(i.generationState))
                }
                onClick={deleteSelected}
              >
                <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('launchesArchiveSelected', { count: selectedIds.size })}
              </Button>
            )}
            <Button
              size="sm"
              color="neutral"
              variant="outline"
              onClick={() => setBulkOpen(current => !current)}
            >
              {t('teamTaskBulkActions')}
            </Button>
            <DropdownMenu
              open={bulkOpen}
              onClose={() => setBulkOpen(false)}
              anchor={bulkAnchor}
              placement="top-start"
              label={t('teamTaskBulkActions')}
              items={[
                {
                  id: 'copy-links',
                  label: t('launchesCopySelectedLinks'),
                  icon: <Link2 size={ICON_SIZE} />,
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
                },
                ...(can('delete')
                  ? [
                      {
                        id: 'archive-selected',
                        label: t('launchesArchiveSelected', { count: selectedIds.size }),
                        icon: (
                          <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                        ),
                        destructive: true,
                        disabled: items.some(
                          item =>
                            selectedIds.has(item.id) && launchInputsLocked(item.generationState)
                        ),
                        onSelect: () => {
                          const selected = items.filter(item => selectedIds.has(item.id));
                          void Promise.all(
                            selected.map(async item => {
                              const warning = await launchApi.archiveWarning(teamId, item.id);
                              return {
                                id: item.id,
                                version: item.version,
                                requestKey: crypto.randomUUID(),
                                hasCatalog: warning.hasCatalog,
                                hasRestitch: warning.hasRestitch,
                                suppressed: warning.suppressed
                              };
                            })
                          )
                            .then(targets => {
                              requestArchive(targets);
                            })
                            .catch(e => setError(teamErrorMessageFor(e, t)));
                          setBulkOpen(false);
                        }
                      }
                    ]
                  : [])
              ]}
            />
          </div>
        }
      />
      <div className="team-task-grid" onPointerDown={launchMarquee.onPointerDown}>
        {items.map(value => (
          <LaunchCard
            key={value.id}
            value={value}
            onOpen={() => route(value.id)}
            selected={selectedIds.has(value.id)}
            onSelectedChange={(selected, modifiers) =>
              selection.select(value.id, selected, modifiers?.shiftKey)
            }
            queueState={batchCardState(
              value,
              batchStates.find(i => i.source.id === value.id)
            )}
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
              <Button variant="ghost" disabled={archiveBusy} onClick={() => setArchiveTarget(null)}>
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
      {ready && !items.length && (
        <div className="flex flex-wrap items-center gap-2">
          <p>{t(filtersActive ? 'launchesFilterEmpty' : 'launchesEmpty')}</p>
          {filtersActive && (
            <Button
              variant="ghost"
              onClick={() => {
                resetListCursor();
                setSearch('');
                setAccountFilter('');
                setAssigneeFilter('');
                setOfferFilter('');
                setDates({ kind: 'all' });
              }}
            >
              {t('launchesFiltersClearAll')}
            </Button>
          )}
        </div>
      )}
      {cursor && (
        <Button
          onClick={() => void readList(cursor).catch(e => setError(teamErrorMessageFor(e, t)))}
        >
          {t('teamExplorerLoadMore')}
        </Button>
      )}
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
            onTab={tab => route(open, tab)}
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
