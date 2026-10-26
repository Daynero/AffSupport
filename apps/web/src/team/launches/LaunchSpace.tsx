import { launchMutation } from './analytics';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link2, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import {
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
  SelectionBar
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { buildTeamRoute, emptyTeamRouteQuery, type TeamRouteQuery } from '../routes';
import { navigateTo } from '../../lib/navigation';
import { TaskDateFilterControl } from '../tasks/TaskDateFilter';
import type { TaskDateFilter } from '../tasks/useTasks';
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
  const [archiveSuppress, setArchiveSuppress] = useState(false);
  const bulkAnchor = useRef<HTMLDivElement>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [cursor, setCursor] = useState<{ id: string; date: string | null } | null>(null);
  const [search, setSearch] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [offerFilter, setOfferFilter] = useState('');
  const [dates, setDates] = useState<TaskDateFilter>({ kind: 'all' });
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
  const scope = useRef({ mounted: true, teamId, actorId, open });
  const closeRequestRef = useRef<() => void>(() => {});
  scope.current.teamId = teamId;
  scope.current.actorId = actorId;
  scope.current.open = open;
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
    async (next: { id: string; date: string | null } | null = null) => {
      const f: {
        search: string;
        accountId?: string;
        assigneeId?: string;
        offerId?: string;
        from?: string;
        to?: string;
        cursorId?: string;
        cursorDate?: string | null;
      } = { search };
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
  const hasRunningLaunch = items.some(
    item =>
      item.generationState !== null &&
      !['succeeded', 'canceled', 'failed', 'partial', 'interrupted'].includes(item.generationState)
  );
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
          if (e instanceof TeamApiError && !e.retryable) {
            detailRead.current = null;
            setDetail(null);
          }
          setError(teamErrorMessageFor(e, t));
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
          <Button type="button" variant="primary" onClick={() => route('new', 'settings')}>
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
      <SelectionBar
        count={selectedIds.size}
        label={t('teamTaskSelectedCount', { count: selectedIds.size })}
        clearLabel={t('teamTaskClearSelection', { count: selectedIds.size })}
        onClear={() => setSelectedIds(new Set())}
        actions={
          <div ref={bulkAnchor} className="team-task-bulk">
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
                        icon: <Trash2 size={ICON_SIZE} />,
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
                                hasRestitch: warning.hasRestitch
                              };
                            })
                          )
                            .then(targets => {
                              setArchiveSuppress(false);
                              setArchiveTarget({ items: targets });
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
            onSelectedChange={selected =>
              setSelectedIds(previous => {
                const next = new Set(previous);
                if (selected) next.add(value.id);
                else next.delete(value.id);
                return next;
              })
            }
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
                        setArchiveSuppress(false);
                        setArchiveTarget({
                          items: [
                            {
                              id: value.id,
                              version: value.version,
                              requestKey: crypto.randomUUID(),
                              hasCatalog: warning.hasCatalog,
                              hasRestitch: warning.hasRestitch
                            }
                          ]
                        });
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
                  const target = archiveTarget;
                  const suppress = target.suppress ?? archiveSuppress;
                  if (target.suppress === undefined) setArchiveTarget({ ...target, suppress });
                  setArchiveBusy(true);
                  void (async () => {
                    for (const item of target.items) {
                      await launchMutation(
                        { flowId: item.requestKey, launchId: item.id },
                        'archive_launch',
                        () =>
                          launchApi.archive(
                            teamId,
                            item.id,
                            item.version,
                            item.requestKey,
                            suppress
                          )
                      );
                    }
                  })()
                    .then(() => {
                      setArchiveTarget(null);
                      setSelectedIds(previous => {
                        const next = new Set(previous);
                        for (const item of target.items) next.delete(item.id);
                        return next;
                      });
                      void refresh().catch(e => setError(teamErrorMessageFor(e, t)));
                    })
                    .catch(e => setError(teamErrorMessageFor(e, t)))
                    .finally(() => setArchiveBusy(false));
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
            (query.launchTab ?? (visibleDetail?.activeRevision ? 'result' : 'settings')) ===
            'result'
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
            tab={query.launchTab ?? (visibleDetail?.activeRevision ? 'result' : 'settings')}
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
