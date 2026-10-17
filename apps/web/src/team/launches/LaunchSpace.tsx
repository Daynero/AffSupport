import { launchMutation, launchObservedGeneration, launchVisible } from './analytics';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  History as HistoryIcon,
  Link2,
  Plus,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react';
import {
  launchInputsLocked,
  launchPreview,
  launchRevisionImpact,
  launchValuesEqual,
  parseLaunchConfig,
  parseLaunchOverrides,
  type LaunchDetail,
  type LaunchConfig,
  type LaunchSourceSnapshot,
  type LaunchOverrides,
  type TeamAccountSummary
} from '@video-compressor/shared';
import { launchApi, teamApi, TeamApiError } from '../../api/team';
import type { LaunchDictionaryItem } from '../../api/launches';
import {
  Button,
  Card,
  Checkbox,
  DropdownMenu,
  IconButton,
  Input,
  Modal,
  Popover,
  SelectionBar,
  Tabs
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useOptionalToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import {
  buildTeamRoute,
  emptyTeamRouteQuery,
  parseTeamRoute,
  type TeamRouteQuery
} from '../routes';
import { BEFORE_NAVIGATION_EVENT, navigateTo } from '../../lib/navigation';
import { TaskDateFilterControl } from '../tasks/TaskDateFilter';
import type { TaskDateFilter } from '../tasks/useTasks';
import { LaunchCard } from './LaunchCard';
import { LaunchEditor } from './LaunchEditor';
import { LaunchResult } from './LaunchResult';
import { LaunchHistory } from './LaunchHistory';
import { LaunchChangeReview } from './LaunchChangeReview';
import { LaunchDefaultsReview } from './LaunchDefaultsReview';
import { LaunchConflictReview } from './LaunchConflictReview';
import { restitchSettingsError } from './recovery';
import { LaunchGenerationProgress } from './LaunchGenerationProgress';
import { useLaunchProgressScroll } from './useLaunchProgressScroll';
import { readLaunchPreparation, LaunchPreparationError } from './preparation';
import { newLaunchDraft, useLaunchDraft } from './useLaunchDraft';
import { mergeLaunchOverrides, useLaunchOverrides } from './useLaunchOverrides';
import { useLaunchMarqueeSelection } from './useLaunchMarqueeSelection';
import { useLaunchGeneration } from './useLaunchGeneration';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useLaunchCopy } from './useLaunchCopy';
import { useLaunchAutosave } from './useLaunchAutosave';
import { LaunchListFilter } from './LaunchListFilter';

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
      teamApi.listMembers(teamId),
      launchApi.dictionaries(teamId),
      launchApi.defaults(teamId)
    ])
      .then(([a, members, d, defs]) => {
        if (!active) return;
        setAccounts(a);
        setAssignees(
          members.map(member => ({
            userId: member.userId,
            label: member.displayName ?? member.email ?? member.userId
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
      <div className="team-panel-heading team-launch-space-heading">
        {can('edit') && (
          <Button type="button" variant="primary" onClick={() => route('new', 'settings')}>
            <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('launchesNew')}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
          <LaunchSession
            key={`${teamId}:${actorId ?? 'preview'}:${sessionIdentity.current.key}`}
            teamId={teamId}
            detail={open === 'new' ? null : visibleDetail}
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
function LaunchSession({
  teamId,
  detail,
  defaults,
  accounts,
  offers,
  buyers,
  editable,
  manage,
  deletable,
  tab,
  revisionId,
  onTab,
  onRevision,
  historical,
  onChange,
  onClose,
  closeRequestRef,
  onDictionaries
}: {
  teamId: string;
  detail: LaunchDetail | null;
  defaults: Awaited<ReturnType<typeof launchApi.defaults>>;
  accounts: TeamAccountSummary[];
  offers: LaunchDictionaryItem[];
  buyers: LaunchDictionaryItem[];
  editable: boolean;
  manage: boolean;
  deletable: boolean;
  tab: 'result' | 'settings';
  revisionId: string | null;
  onTab: (tab: 'result' | 'settings') => void;
  onRevision: (id: string) => void;
  historical: boolean;
  onChange: (detail: LaunchDetail, tab?: 'result' | 'settings') => void;
  onClose: () => void;
  closeRequestRef: { current: () => void };
  onDictionaries: () => Promise<void>;
}) {
  const { t } = useI18n();
  const toasts = useOptionalToasts();
  const draft = useLaunchDraft(detail);
  const progressScroll = useLaunchProgressScroll();
  const latestProgressDetail = useRef(detail);
  latestProgressDetail.current = detail;
  const generationClick = useRef(false);
  const preflightAbort = useRef<AbortController | null>(null);
  useEffect(() => () => preflightAbort.current?.abort(), []);
  const [preflighting, setPreflighting] = useState(false);
  const manual = useLaunchOverrides(detail);
  const { overrides, setOverrides } = manual;
  const [error, setError] = useState<string | null>(null);
  const [requestErrorCode, setRequestErrorCode] = useState<string | null>(null);
  const reportError = (failure: unknown) => {
    setRequestErrorCode(
      failure instanceof TeamApiError
        ? failure.code
        : failure instanceof Error
          ? failure.message
          : null
    );
    setError(teamErrorMessageFor(failure, t));
  };
  const [catalogSetupMissing, setCatalogSetupMissing] = useState(false);
  const [working, setWorking] = useState(false);
  const [autosaving, setAutosaving] = useState(false);
  const preparationStatusId = useId();
  const autosaveError = useRef<string | null>(null);
  const workingRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [dictionaryBusy, setDictionaryBusy] = useState(false);
  const dictionaryRequests = useRef(0);
  const [submitted, setSubmitted] = useState(false);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof launchApi.history>>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [retention, setRetention] = useState<{
    hasCatalog: boolean;
    hasRestitch: boolean;
    suppressed: boolean;
  } | null>(null);
  const [suppress, setSuppress] = useState(false);
  const [defaultsVersion, setDefaultsVersion] = useState(defaults?.version ?? null);
  const [versionRejected, setVersionRejected] = useState(false);
  const [conflictReview, setConflictReview] = useState<LaunchDetail | null>(null);
  const [defaultsConflict, setDefaultsConflict] = useState(false);
  const [defaultsReview, setDefaultsReview] = useState<{
    current: Awaited<ReturnType<typeof launchApi.defaults>>;
  } | null>(null);
  const copying = useLaunchCopy(teamId, next => onChange(next, 'settings'));
  const saveIntent = useRef<Parameters<typeof launchApi.save>[0] | null>(null);
  const defaultsIntent = useRef<Parameters<typeof launchApi.setDefaults> | null>(null);
  const overridesIntent = useRef<Parameters<typeof launchApi.overrides> | null>(null);
  const overridesRetry = useRef<() => Promise<void>>(async () => {});
  const overridesRetryAttempt = useRef(0);
  const archiveIntent = useRef<Parameters<typeof launchApi.archive> | null>(null);
  const workingCopyIntent = useRef<Parameters<typeof launchApi.saveWorkingCopy>[0] | null>(null);
  type GenerationRequest = {
    detail: LaunchDetail | null;
    config: LaunchConfig;
    sources: LaunchSourceSnapshot;
    version: string | null;
    key: string;
    impact: ReturnType<typeof launchRevisionImpact> | null;
  };
  const [changeReview, setChangeReview] = useState<GenerationRequest | null>(null);
  const ownedKey = useRef<string | null>(null);
  const pendingGeneration = useRef<string | null>(null);
  const approvedOutputs = useRef<LaunchOverrides | null>(null);
  const approvedConfig = useRef<{ config: LaunchConfig; sources: LaunchSourceSnapshot } | null>(
    null
  );
  const currentConfig = parseLaunchConfig(draft.config);
  const currentSignature = {
    config: currentConfig.ok ? currentConfig.value : draft.config,
    sources: draft.sources
  };
  const unchangedApproval =
    approvedOutputs.current !== null &&
    approvedConfig.current !== null &&
    launchValuesEqual(approvedOutputs.current, overrides) &&
    launchValuesEqual(approvedConfig.current, currentSignature);
  const generated = (next: LaunchDetail) => {
    const own = next.generation?.requestKey === ownedKey.current;
    if (own && launchValuesEqual(approvedOutputs.current, overrides)) {
      manual.acknowledge({});
      setOverrides({});
    }
    if (own && launchValuesEqual(approvedConfig.current, currentSignature))
      draft.acknowledge(next.draft, next.expectedSourceSnapshot, next.version);
    pendingGeneration.current = null;
    ownedKey.current = null;
    approvedOutputs.current = null;
    approvedConfig.current = null;
    onChange(next, 'result');
  };
  const generation = useLaunchGeneration(
    teamId,
    next => {
      const g = next.generation;
      if (g && !['succeeded', 'canceled'].includes(g.state)) {
        ownedKey.current ??= g.requestKey ?? null;
        if (g.requestKey === ownedKey.current) pendingGeneration.current = g.id;
      }
      if (g?.state === 'succeeded') generated(next);
      else {
        if (!draft.dirty || launchValuesEqual(approvedConfig.current, currentSignature))
          draft.acknowledge(next.draft, next.expectedSourceSnapshot, next.version);
        if (g?.state === 'canceled') {
          pendingGeneration.current = null;
          ownedKey.current = null;
          approvedOutputs.current = null;
          approvedConfig.current = null;
        }
        onChange(next, 'settings');
      }
    },
    receipt => {
      draft.acknowledge(receipt.config, receipt.sources, receipt.version);
      if (!detail) {
        onChange({
          id: receipt.id,
          version: receipt.version,
          draft: receipt.config,
          expectedSourceSnapshot: receipt.sources,
          assigneeId: null,
          workStatus: 'todo',
          activeRevision: null,
          generation: null
        });
      } else if (detail.id === receipt.id) {
        if (manual.revision?.id === detail.activeRevision?.id) manual.advanceBase(receipt.version);
        onChange({
          ...detail,
          version: receipt.version,
          draft: receipt.config,
          expectedSourceSnapshot: receipt.sources
        });
      }
    }
  );
  const observeProgress = useRef(generation.observe);
  observeProgress.current = generation.observe;
  useEffect(() => {
    if (detail && observeProgress.current?.(detail)) {
      setError(null);
      setRequestErrorCode(null);
    }
  }, [detail]);
  const inputLocked =
    preflighting ||
    generation.busy ||
    copying.busy ||
    copying.hasUnresolvedRequest ||
    working ||
    launchInputsLocked(detail?.generation?.state ?? null) ||
    generation.hasUnresolvedRequest ||
    saveIntent.current !== null ||
    defaultsIntent.current !== null ||
    overridesIntent.current !== null ||
    archiveIntent.current !== null ||
    workingCopyIntent.current !== null ||
    restoreTarget !== null ||
    changeReview !== null;
  const locked = inputLocked || autosaving;
  const generationLocked =
    preflighting ||
    launchInputsLocked(detail?.generation?.state ?? null) ||
    generation.busy ||
    generation.hasUnresolvedRequest;
  const inputAuthority = useRef({ locked, editable, mounted: true, generationLocked });
  inputAuthority.current.locked = inputLocked;
  inputAuthority.current.editable = editable;
  inputAuthority.current.generationLocked = generationLocked;
  useEffect(() => {
    inputAuthority.current.mounted = true;
    return () => {
      inputAuthority.current.mounted = false;
    };
  }, []);
  useEffect(() => {
    const g = detail?.generation;
    if (!g) return;
    if (g.state === 'succeeded' && pendingGeneration.current === g.id) {
      generated(detail);
    } else if (g.state === 'canceled') pendingGeneration.current = null;
  }, [detail, draft.acknowledge, onChange]);
  const active = manual.revision;
  const displayedRevision = historical ? (detail?.activeRevision ?? null) : active;
  const displayedOverrides = historical ? (detail?.activeRevision?.overrides ?? {}) : overrides;
  const overridesDirty = manual.dirty;
  useEffect(() => {
    if (!detail || !active || !overridesDirty || manual.baseVersion === detail.version) return;
    const merged = mergeLaunchOverrides(
      active.overrides,
      overrides,
      detail.activeRevision?.overrides ?? {}
    );
    manual.replace(detail);
    manual.setOverrides(merged);
  }, [
    detail,
    active,
    overridesDirty,
    overrides,
    manual.baseVersion,
    manual.replace,
    manual.setOverrides
  ]);
  const observed = useRef(new Set<string>());
  useEffect(() => {
    if (!detail?.generation) return;
    const g = detail.generation;
    const key = `${g.id}:${g.stage}:${g.state}`;
    if (observed.current.has(key)) return;
    observed.current.add(key);
    launchObservedGeneration({ launchId: detail.id, generationId: g.id }, g);
  }, [detail?.id, detail?.generation]);
  useEffect(() => {
    if (tab !== 'result' || !displayedRevision) return;
    const key = `visible:${displayedRevision.id}`;
    if (observed.current.has(key)) return;
    observed.current.add(key);
    launchVisible({
      launchId: detail?.id,
      revisionId: displayedRevision.id,
      generationId:
        displayedRevision.kind === 'generated'
          ? (displayedRevision.generationId ?? undefined)
          : undefined
    });
  }, [tab, displayedRevision, detail?.id]);
  const initial = useRef(false);
  const sourceRequest = useRef(0);
  const sourceChoice = useRef({ offers: 0, buyers: 0 });
  const [sourcesPending, setSourcesPending] = useState(false);
  const selectedAccount = accounts.find(account =>
    account.agents.some(agent => agent.id === draft.config.agentRowId)
  );
  const selectedAgent = selectedAccount?.agents.find(agent => agent.id === draft.config.agentRowId);
  const sourceChanged =
    draft.sources !== null &&
    (selectedAccount?.id !== draft.sources.accountId ||
      selectedAccount.name !== draft.sources.social ||
      selectedAgent?.agentId !== draft.sources.agentId ||
      buyers.find(buyer => buyer.id === draft.config.buyerId)?.value !== draft.sources.buyer ||
      offers.find(offer => offer.id === draft.config.offerId)?.value !== draft.sources.offer);
  useEffect(() => {
    if (initial.current) return;
    initial.current = true;
    if (!detail && defaults) {
      const next = { ...newLaunchDraft(), ...defaults.config, subConfig: defaults.subConfig };
      if (next.buyerId && !buyers.some(buyer => buyer.id === next.buyerId)) {
        delete next.buyerId;
        setError(t('launchesDefaultBuyerMissing'));
      }
      draft.acknowledge(next);
      draft.setConfig(next);
    }
  }, [detail, defaults, draft, buyers, t]);
  useEffect(() => {
    if (!overridesDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [overridesDirty]);
  useEffect(() => {
    const before = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.path !== 'string') return;
      const route = parseTeamRoute(event.detail.path);
      if (
        route?.kind === 'space' &&
        route.spaceId === teamId &&
        route.section === 'launches' &&
        route.query.launchId === (detail?.id ?? 'new') &&
        (route.query.revisionId ?? null) === revisionId
      )
        return;
      if ((draft.isDirty() || manual.isDirty()) && !window.confirm(t('launchesUnsaved')))
        event.preventDefault();
    };
    window.addEventListener(BEFORE_NAVIGATION_EVENT, before);
    return () => window.removeEventListener(BEFORE_NAVIGATION_EVENT, before);
  }, [draft, manual, teamId, detail?.id, revisionId, t]);
  const refreshSources = useCallback(
    async (live = false) => {
      const seq = ++sourceRequest.current;
      setSourcesPending(true);
      try {
        const sources = await (live
          ? launchApi.refreshSources(teamId, draft.config)
          : launchApi.selection(teamId, draft.config));
        if (
          seq === sourceRequest.current &&
          inputAuthority.current.mounted &&
          !inputAuthority.current.locked &&
          inputAuthority.current.editable
        )
          draft.resolveSources(sources);
        else if (seq === sourceRequest.current && inputAuthority.current.mounted)
          lastIds.current = null;
      } catch (e) {
        if (
          seq === sourceRequest.current &&
          inputAuthority.current.mounted &&
          !inputAuthority.current.locked
        ) {
          draft.setSources(null);
          reportError(e);
        }
      } finally {
        if (seq === sourceRequest.current && inputAuthority.current.mounted)
          setSourcesPending(false);
      }
    },
    [teamId, draft.config, draft.resolveSources, t]
  );
  const sourceIds = [
    draft.config.agentRowId,
    draft.config.offerId,
    draft.config.buyerId,
    draft.config.materialId,
    draft.config.method,
    draft.config.catalog?.restitchEnabled
  ].join('|');
  const lastIds = useRef<string | null>(draft.sources ? sourceIds : null);
  useEffect(() => {
    if (!editable || locked || sourceIds === lastIds.current) return;
    lastIds.current = sourceIds;
    sourceRequest.current++;
    setSourcesPending(false);
    draft.setSources(null);
    if (
      ![
        draft.config.agentRowId,
        draft.config.offerId,
        draft.config.buyerId,
        draft.config.materialId
      ].every(Boolean)
    )
      return;
    void refreshSources();
  }, [sourceIds, refreshSources, draft.sources, draft.config, editable, locked]);
  const run = async (action: () => Promise<void>) => {
    if (workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    inputAuthority.current.locked = true;
    setError(null);
    setRequestErrorCode(null);
    try {
      await action();
    } catch (e) {
      // Only a proven rejection releases the frozen mutation. A transport/invalid
      // response may have committed and must replay the same key and payload.
      if (
        e instanceof TeamApiError &&
        [
          'LAUNCH_VERSION_CONFLICT',
          'FORBIDDEN',
          'PERMISSION_DENIED',
          'NOT_FOUND',
          'INVALID_INPUT',
          'SOURCE_CHANGED',
          'LAUNCH_SUB_INVALID'
        ].includes(e.code)
      ) {
        if (defaultsIntent.current && e.code === 'LAUNCH_VERSION_CONFLICT')
          setDefaultsConflict(true);
        if (!defaultsIntent.current && e.code === 'LAUNCH_VERSION_CONFLICT')
          setVersionRejected(true);
        saveIntent.current = null;
        defaultsIntent.current = null;
        overridesIntent.current = null;
        archiveIntent.current = null;
        workingCopyIntent.current = null;
      }
      if (inputAuthority.current.mounted) reportError(e);
    } finally {
      workingRef.current = false;
      if (inputAuthority.current.mounted) setWorking(false);
    }
  };
  const reload = async (id: string) => {
    const next = await launchApi.detail(teamId, id);
    if (inputAuthority.current.mounted) onChange(next);
  };
  const refreshProgress = async (signal: AbortSignal) => {
    const requested = latestProgressDetail.current;
    if (!requested) return;
    let next: LaunchDetail;
    try {
      next = await launchApi.detail(teamId, requested.id, null, signal);
    } catch (error) {
      if (
        !signal.aborted &&
        inputAuthority.current.mounted &&
        latestProgressDetail.current?.id === requested.id &&
        error instanceof TeamApiError &&
        ['PERMISSION_DENIED', 'SPACE_BLOCKED', 'NOT_FOUND', 'INVALID_RESPONSE'].includes(error.code)
      )
        onClose();
      throw error;
    }
    const current = latestProgressDetail.current;
    if (
      signal.aborted ||
      !inputAuthority.current.mounted ||
      current?.id !== requested.id ||
      current.generation?.id !== requested.generation?.id ||
      BigInt(next.version) < BigInt(current.version)
    )
      return;
    if (
      next.generation?.id === current.generation?.id &&
      next.generation &&
      current.generation &&
      BigInt(next.generation.stateVersion) < BigInt(current.generation.stateVersion)
    )
      return;
    if (generation.observe?.(next)) setError(null);
    setRequestErrorCode(null);
    onChange(next);
  };
  overridesRetry.current = async () => {
    const intended = overridesIntent.current;
    if (!intended) return;
    try {
      await launchMutation(
        { flowId: intended[4], launchId: intended[1], revisionId: intended[2] },
        'save_overrides',
        () => launchApi.overrides(...intended)
      );
    } catch (retryError) {
      if (!(retryError instanceof TeamApiError) || retryError.code !== 'LAUNCH_VERSION_CONFLICT')
        throw retryError;
      const latest = await launchApi.detail(teamId, intended[1]);
      if (!inputAuthority.current.mounted) return;
      const merged = mergeLaunchOverrides(
        manual.revision?.overrides ?? {},
        manual.overrides,
        latest.activeRevision?.overrides ?? {}
      );
      overridesIntent.current = null;
      overridesRetryAttempt.current = 0;
      manual.replace(latest);
      manual.setOverrides(merged);
      onChange(latest);
      return;
    }
    overridesIntent.current = null;
    overridesRetryAttempt.current = 0;
    const next = await launchApi.detail(teamId, intended[1]);
    if (!inputAuthority.current.mounted) return;
    manual.acknowledge();
    onChange(next);
  };
  useEffect(() => {
    if (working || !overridesIntent.current) return;
    const delay = Math.min(30_000, 800 * 2 ** Math.min(overridesRetryAttempt.current, 5));
    const timer = window.setTimeout(() => {
      overridesRetryAttempt.current += 1;
      void run(() => overridesRetry.current());
    }, delay);
    return () => window.clearTimeout(timer);
  }, [working]);
  const save = async () => {
    if (!saveIntent.current)
      saveIntent.current = {
        teamId,
        id: detail?.id ?? null,
        version: draft.baseVersion,
        requestKey: crypto.randomUUID(),
        config: draft.config,
        sources: draft.sources
      };
    const intended = saveIntent.current;
    const result = await launchMutation(
      { flowId: intended.requestKey, launchId: intended.id ?? undefined },
      'save_draft',
      () => launchApi.save(intended)
    );
    saveIntent.current = null;
    draft.acknowledge(intended.config, intended.sources, result.version);
    await reload(result.id);
  };
  useLaunchAutosave({
    enabled:
      editable &&
      !historical &&
      !inputLocked &&
      !manual.dirty &&
      !versionRejected &&
      !sourcesPending,
    dirty: draft.dirty,
    teamId,
    id: detail?.id ?? null,
    version: draft.baseVersion,
    config: draft.config,
    sources: draft.sources,
    save: request => {
      const correlation = { flowId: request.requestKey, launchId: request.id ?? undefined };
      return launchMutation(correlation, 'save_draft', async () => {
        const result = await launchApi.save(request);
        correlation.launchId = result.id;
        return result;
      });
    },
    onSaving: setAutosaving,
    onSaved: (request, result) => {
      const previousError = autosaveError.current;
      if (previousError) setError(current => (current === previousError ? null : current));
      autosaveError.current = null;
      draft.acknowledge(request.config, request.sources, result.version);
      manual.advanceBase(result.version);
      onChange({
        ...(detail ?? {
          assigneeId: null,
          workStatus: 'todo',
          activeRevision: null,
          generation: null
        }),
        id: result.id,
        version: result.version,
        draft: request.config,
        expectedSourceSnapshot: request.sources
      });
    },
    onError: error => {
      const message = teamErrorMessageFor(error, t);
      autosaveError.current = message;
      setError(message);
      if (error instanceof TeamApiError && error.code === 'LAUNCH_VERSION_CONFLICT')
        setVersionRejected(true);
    },
    canRecoverOnEdit: error =>
      error instanceof TeamApiError &&
      [
        'INVALID_INPUT',
        'LAUNCH_URL_INVALID',
        'LAUNCH_BUDGET_INVALID',
        'LAUNCH_SUB_INVALID'
      ].includes(error.code),
    retryable: error => (error instanceof TeamApiError ? error.retryable : true)
  });
  const copy = async () => {
    if (!detail) return;
    await copying.copy({
      id: detail.id,
      version: detail.version,
      revisionId: historical ? detail.activeRevision?.id : active?.id
    });
  };
  const generate = async () => {
    if (generationClick.current || generation.busy) return;
    generationClick.current = true;
    const preflight = new AbortController();
    preflightAbort.current = preflight;
    progressScroll.reveal();
    setError(null);
    setRequestErrorCode(null);
    setPreflighting(true);
    try {
      await generateRequested(preflight.signal);
    } finally {
      if (preflightAbort.current === preflight) preflightAbort.current = null;
      generationClick.current = false;
      if (inputAuthority.current.mounted) setPreflighting(false);
    }
  };
  const generateRequested = async (signal: AbortSignal) => {
    if (generation.hasUnresolvedRequest) {
      setPreflighting(false);
      try {
        await generation.generate(detail, draft.config, draft.sources, draft.baseVersion);
      } catch (e) {
        if (inputAuthority.current.mounted) reportError(e);
      }
      return;
    }
    if (uploading || sourcesPending || dictionaryRequests.current > 0) return;
    setSubmitted(true);
    const key = generation.intent(draft.config.method ?? 'other', detail?.id);
    if (sourceChanged) {
      generation.blocked('SOURCE_CHANGED');
      setError(t('launchesSourceChanged'));
      return;
    }
    const parsed = parseLaunchConfig(draft.config);
    if (!parsed.ok || !draft.sources) {
      generation.blocked('INVALID_INPUT');
      setError(t('launchesInvalid'));
      return;
    }
    const preview = launchPreview(parsed.value, draft.sources);
    if (!preview.ok) {
      generation.blocked('INVALID_INPUT');
      setError(t('launchesInvalid'));
      return;
    }
    if (parsed.value.method === 'catalog') {
      try {
        const [settings, texts, images] = await readLaunchPreparation(
          Promise.all([
            teamApi.getProductCatalogSettings(teamId),
            teamApi.listProductCatalogTexts(teamId),
            teamApi.listProductCatalogImageSources(teamId)
          ]),
          signal
        );
        if (
          !settings ||
          (texts.length === 0 && (!settings.title || !settings.description)) ||
          (images.poolSize === 0 && !settings.imageLink)
        ) {
          generation.blocked('WRONG_STATE');
          setCatalogSetupMissing(true);
          setError(t('launchesCatalogSetupMissing'));
          return;
        }
        setCatalogSetupMissing(false);
      } catch (e) {
        if (!inputAuthority.current.mounted) return;
        if (e instanceof LaunchPreparationError) {
          generation.blocked(
            e.reason === 'canceled' ? 'PROCESS_CANCELED' : 'LAUNCH_RESULT_UNCERTAIN'
          );
          if (e.reason === 'timeout') setError(t('launchesProgressPreparationFailed'));
          return;
        }
        generation.blocked(e instanceof TeamApiError ? e.code : 'UNKNOWN');
        reportError(e);
        return;
      }
    }
    if (signal.aborted || !inputAuthority.current.mounted) return;
    const request: GenerationRequest = {
      detail,
      config: parsed.value,
      sources: draft.sources,
      version: draft.baseVersion,
      key,
      impact:
        (detail?.activeRevision ?? active)
          ? launchRevisionImpact(
              (detail?.activeRevision ?? active)!.baseline,
              preview.value,
              (detail?.activeRevision ?? active)!.config,
              parsed.value,
              (detail?.activeRevision ?? active)!.sources,
              draft.sources
            )
          : null
    };
    if (active) setChangeReview(request);
    else await executeGeneration(request);
  };
  const executeGeneration = async (request: GenerationRequest) => {
    if (!generationClick.current) progressScroll.reveal();
    setPreflighting(false);
    setError(null);
    setRequestErrorCode(null);
    setChangeReview(null);
    inputAuthority.current.locked = true;
    inputAuthority.current.generationLocked = true;
    draft.setConfig(request.config);
    ownedKey.current = request.key;
    approvedOutputs.current = overrides;
    approvedConfig.current = { config: request.config, sources: request.sources };
    try {
      await generation.generate(request.detail, request.config, request.sources, request.version);
    } catch (e) {
      if (inputAuthority.current.mounted) reportError(e);
    }
  };
  const resumeGeneration = async () => {
    if (!detail || generationClick.current || generation.busy || workingRef.current) return;
    generationClick.current = true;
    progressScroll.reveal();
    setError(null);
    setRequestErrorCode(null);
    try {
      await generation.resume(detail);
    } catch (error) {
      if (inputAuthority.current.mounted) reportError(error);
    } finally {
      generationClick.current = false;
    }
  };
  const close = () => {
    if (workingRef.current || autosaving) return;
    if (!draft.dirty && !manual.dirty) {
      onClose();
      return;
    }
    void run(async () => {
      if (!detail) {
        await save();
      } else {
        if (draft.dirty && manual.dirty && draft.baseVersion !== manual.baseVersion)
          throw new TeamApiError('LAUNCH_VERSION_CONFLICT', false);
        const parsed = parseLaunchOverrides(overrides, active?.config.campaignCount ?? 0);
        if (manual.dirty && (!active || !parsed.ok)) throw new TeamApiError('INVALID_INPUT', false);
        const version = draft.dirty ? draft.baseVersion : manual.baseVersion;
        if (!version) throw new TeamApiError('LAUNCH_VERSION_CONFLICT', false);
        workingCopyIntent.current ??= {
          teamId,
          id: detail.id,
          version,
          requestKey: crypto.randomUUID(),
          config: draft.dirty ? draft.config : null,
          sources: draft.dirty ? draft.sources : null,
          baselineId: manual.dirty && active ? (active.baselineRevisionId ?? active.id) : null,
          overrides: manual.dirty && parsed.ok ? parsed.value : null
        };
        const intended = workingCopyIntent.current;
        if (!intended) throw new TeamApiError('LAUNCH_VERSION_CONFLICT', false);
        const saved = await launchMutation(
          { flowId: intended.requestKey, launchId: intended.id },
          'save_draft',
          () => launchApi.saveWorkingCopy(intended)
        );
        workingCopyIntent.current = null;
        draft.acknowledge(
          intended.config ?? draft.config,
          intended.sources ?? draft.sources,
          saved.version
        );
        manual.acknowledge(intended.overrides ?? overrides);
        manual.advanceBase(saved.version);
      }
      onClose();
    });
  };
  closeRequestRef.current = close;
  const restore = async (revisionId: string, saveEdits: boolean) => {
    if (!detail) return;
    return launchMutation(
      { flowId: crypto.randomUUID(), launchId: detail.id, revisionId },
      'restore_config',
      async () => {
        let saved: Awaited<ReturnType<typeof launchApi.saveWorkingCopy>> | null = null;
        if (saveEdits) {
          if (!workingCopyIntent.current) {
            if (draft.dirty && manual.dirty && draft.baseVersion !== manual.baseVersion)
              throw new TeamApiError('LAUNCH_VERSION_CONFLICT', false);
            const version = draft.dirty ? draft.baseVersion : manual.baseVersion;
            if (!version) throw new TeamApiError('LAUNCH_VERSION_CONFLICT', false);
            const parsed = parseLaunchOverrides(overrides, active?.config.campaignCount ?? 0);
            if (manual.dirty && (!active || !parsed.ok))
              throw new TeamApiError('INVALID_INPUT', false);
            workingCopyIntent.current = {
              teamId,
              id: detail.id,
              version,
              requestKey: crypto.randomUUID(),
              config: draft.dirty ? draft.config : null,
              sources: draft.dirty ? draft.sources : null,
              baselineId: manual.dirty && active ? (active.baselineRevisionId ?? active.id) : null,
              overrides: manual.dirty && parsed.ok ? parsed.value : null
            };
          }
          const intended = workingCopyIntent.current;
          saved = await launchMutation(
            { flowId: intended.requestKey, launchId: intended.id },
            'save_draft',
            () => launchApi.saveWorkingCopy(intended)
          );
        }
        const latest = await launchApi.detail(teamId, detail.id);
        if (!inputAuthority.current.mounted || !inputAuthority.current.editable)
          throw new TeamApiError('PERMISSION_DENIED', false);
        if (saved && workingCopyIntent.current) {
          const intended = workingCopyIntent.current;
          draft.acknowledge(
            intended.config ?? draft.config,
            intended.config ? intended.sources : draft.sources,
            saved.version
          );
          manual.acknowledge(intended.overrides ?? overrides);
          workingCopyIntent.current = null;
          onChange(latest);
          setRestoreTarget(null);
        }
        const old = await launchApi.detail(teamId, detail.id, revisionId);
        if (!inputAuthority.current.mounted || !inputAuthority.current.editable)
          throw new TeamApiError('PERMISSION_DENIED', false);
        if (
          inputAuthority.current.generationLocked ||
          launchInputsLocked(old.generation?.state ?? null) ||
          launchInputsLocked(latest.generation?.state ?? null)
        )
          throw new TeamApiError('LAUNCH_BUSY', true);
        if (!old.activeRevision) throw new TeamApiError('NOT_FOUND', false);
        if (!saved) manual.discard();
        workingCopyIntent.current = null;
        onChange(latest);
        lastIds.current = null;
        draft.setConfig(old.activeRevision.config);
        draft.setSources(null);
        setRestoreTarget(null);
        onTab('settings');
      }
    );
  };
  const archive = async (suppressWarning: boolean) => {
    if (!detail) return;
    archiveIntent.current ??= [
      teamId,
      detail.id,
      detail.version,
      crypto.randomUUID(),
      suppressWarning
    ];
    const intended = archiveIntent.current;
    await launchMutation({ flowId: intended[3], launchId: intended[1] }, 'archive_launch', () =>
      launchApi.archive(...intended)
    );
    archiveIntent.current = null;
    if (inputAuthority.current.mounted) onClose();
  };
  const openRestitchSettings = () =>
    navigateTo(
      buildTeamRoute({
        spaceId: teamId,
        section: 'launches',
        query: {
          ...emptyTeamRouteQuery(),
          launchId: detail?.id ?? 'new',
          launchTab: tab,
          settings: true,
          settingsTab: 'restitch'
        }
      })
    );
  const showProgress =
    preflighting ||
    generation.busy ||
    generation.hasUnresolvedRequest ||
    Boolean(detail?.generation && !['succeeded', 'canceled'].includes(detail.generation.state));
  const preparationStatus = historical
    ? null
    : uploading
      ? t('launchesPreparingCreative')
      : sourcesPending
        ? t('launchesCheckingSources')
        : dictionaryBusy
          ? t('launchesSavingSelection')
          : autosaving
            ? t('launchesSavingDraft')
            : null;
  // One persistent status owns all ordinary edit/save feedback. Debounce and network
  // saves share a label, so typing does not cycle through several fleeting messages.
  const unsavedChanges = draft.dirty || overridesDirty;
  const saveNeedsAttention = unsavedChanges && Boolean(error || sourceChanged || versionRejected);
  const savingChanges =
    !historical &&
    editable &&
    !saveNeedsAttention &&
    (autosaving || (unsavedChanges && (!inputLocked || overridesIntent.current !== null)));
  const statusBusy = !saveNeedsAttention && (savingChanges || Boolean(preparationStatus));
  const saveStatus = historical
    ? t('launchesSavedVersion')
    : saveNeedsAttention
      ? t('launchesDraftPending')
      : uploading
        ? t('launchesPreparingCreative')
        : savingChanges
          ? t('launchesSavingDraft')
          : (preparationStatus ??
            (unsavedChanges
              ? t('launchesDraftPending')
              : detail
                ? t(tab === 'result' ? 'launchesChangesSaved' : 'launchesDraftSaved')
                : t('launchesAutosave')));
  return (
    <div
      ref={progressScroll.anchor}
      className="launch-detail mx-auto box-border flex w-full min-w-0 max-w-none flex-col gap-3 p-3 sm:p-4"
    >
      <div className="launch-detail-toolbar flex flex-wrap items-center gap-2 rounded-control bg-surface p-2">
        <Button
          variant="ghost"
          className="launch-detail-close"
          disabled={locked}
          onClick={close}
          aria-label={t('teamCancel')}
        >
          <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </Button>
        <Tabs
          label={t('launchesTitle')}
          value={tab}
          onChange={next => {
            if (next === 'result' || next === 'settings') onTab(next);
          }}
          items={[
            { id: 'result', label: t('launchesResult'), disabled: !displayedRevision },
            { id: 'settings', label: t('launchesSettings') }
          ]}
        />
        {detail && editable && (
          <Button
            variant="ghost"
            color="neutral"
            className="launch-detail-copy"
            aria-label={t('launchesCopy')}
            title={t(
              unsavedChanges || preparationStatus ? 'launchesCopySavedNotice' : 'launchesCopy'
            )}
            disabled={
              working ||
              copying.busy ||
              generation.busy ||
              ((locked || unsavedChanges || Boolean(preparationStatus)) &&
                !copying.hasUnresolvedRequest)
            }
            onClick={() =>
              void run(async () => {
                await copy();
              })
            }
          >
            <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </Button>
        )}
        {detail && deletable && (
          <IconButton
            label={t('launchesArchive')}
            title=""
            variant="ghost"
            color="error"
            className="launch-detail-delete"
            disabled={working || generation.busy || (locked && archiveIntent.current === null)}
            onClick={() =>
              void run(async () => {
                if (archiveIntent.current) {
                  await archive(archiveIntent.current[4]);
                  return;
                }
                const warning = await launchApi.archiveWarning(teamId, detail.id);
                if (!inputAuthority.current.mounted) return;
                if (warning.hasCatalog && !warning.suppressed) {
                  setRetention(warning);
                  setSuppress(false);
                } else {
                  await archive(false);
                }
              })
            }
          >
            <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        )}
      </div>
      <div
        className="launch-draft-save-status"
        id={preparationStatusId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="launch-draft-save-indicator" aria-hidden="true">
          {statusBusy ? (
            <span className="ui-spinner" />
          ) : !unsavedChanges && detail ? (
            <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          ) : null}
        </span>
        <span className="launch-draft-save-label" title={saveStatus}>
          {saveStatus}
        </span>
      </div>
      {sourceChanged && (
        <p role="status" className="text-warning-text">
          {t('launchesSourceChanged')}
        </p>
      )}
      {detail &&
        editable &&
        !historical &&
        ((versionRejected && draft.dirty) ||
          (draft.dirty && draft.baseVersion !== detail.version)) && (
          <LaunchConflictReview
            current={conflictReview}
            disabled={locked}
            decisionDisabled={
              conflictReview !== null &&
              launchInputsLocked(conflictReview.generation?.state ?? null)
            }
            canKeep={
              !manual.dirty ||
              (conflictReview?.activeRevision !== null &&
                (manual.revision?.baselineRevisionId ?? manual.revision?.id) ===
                  (conflictReview?.activeRevision?.baselineRevisionId ??
                    conflictReview?.activeRevision?.id))
            }
            onReload={() =>
              void run(async () => {
                const current = await launchApi.detail(teamId, detail.id);
                if (inputAuthority.current.mounted) setConflictReview(current);
              })
            }
            onKeep={() => {
              if (!conflictReview) return;
              draft.acknowledge(
                conflictReview.draft,
                conflictReview.expectedSourceSnapshot,
                conflictReview.version
              );
              manual.advanceBase(conflictReview.version);
              setVersionRejected(false);
              setConflictReview(null);
              onChange(conflictReview);
            }}
            onTake={() => {
              if (!conflictReview) return;
              draft.acknowledge(
                conflictReview.draft,
                conflictReview.expectedSourceSnapshot,
                conflictReview.version
              );
              draft.setConfig(conflictReview.draft);
              draft.setSources(conflictReview.expectedSourceSnapshot);
              manual.replace(conflictReview);
              setVersionRejected(false);
              setConflictReview(null);
              onChange(conflictReview);
            }}
          />
        )}
      {generation.hasUnresolvedRequest && (
        <Button disabled={generation.busy} onClick={() => void generate()}>
          {t(generation.pendingStage === 'cancel' ? 'launchesProgressRetryCancel' : 'retry')}
        </Button>
      )}
      {editable &&
        detail?.generation?.requestKey &&
        !['succeeded', 'canceled'].includes(detail.generation.state) && (
          <Button
            disabled={
              working || generation.busy || draft.dirty || (overridesDirty && !unchangedApproval)
            }
            onClick={() => void resumeGeneration()}
          >
            {t('retry')}
          </Button>
        )}
      {saveIntent.current && (
        <Button disabled={working} onClick={() => void run(save)}>
          {t('retry')}
        </Button>
      )}
      {error && !showProgress && !detail?.generation?.errorCode && (
        <p role="alert" className="text-error-text">
          {error}
        </p>
      )}
      {!showProgress && error && restitchSettingsError(requestErrorCode) && (
        <Button onClick={openRestitchSettings}>{t('launchesOpenRestitchSettings')}</Button>
      )}
      {catalogSetupMissing && (
        <Button
          onClick={() =>
            navigateTo(
              buildTeamRoute({
                spaceId: teamId,
                section: 'launches',
                query: {
                  ...emptyTeamRouteQuery(),
                  settings: true,
                  settingsTab: 'product-catalog'
                }
              })
            )
          }
        >
          {t('launchesOpenCatalogSettings')}
        </Button>
      )}
      {defaultsConflict && manage && (
        <Button
          disabled={locked}
          onClick={() =>
            void run(async () => {
              const current = await launchApi.defaults(teamId);
              if (inputAuthority.current.mounted) setDefaultsReview({ current });
            })
          }
        >
          {t('launchesDefaultsReload')}
        </Button>
      )}
      {defaultsReview && manage && (
        <LaunchDefaultsReview
          current={defaultsReview.current}
          buyer={
            buyers.find(item => item.id === defaultsReview.current?.config.buyerId)?.value ?? ''
          }
          disabled={locked}
          onReview={() => {
            setDefaultsVersion(defaultsReview.current?.version ?? null);
            setDefaultsConflict(false);
            setDefaultsReview(null);
          }}
        />
      )}
      {changeReview?.impact && (
        <LaunchChangeReview
          impact={changeReview.impact}
          restitch={
            changeReview.config.method === 'catalog' && changeReview.config.catalog.restitchEnabled
          }
          unsavedOutputs={overridesDirty}
          disabled={working || generationLocked}
          onConfirm={() => void executeGeneration(changeReview)}
          onCancel={() => {
            setChangeReview(null);
            generation.abandon();
          }}
        />
      )}
      {retention && detail && (
        <Card
          role="section"
          title={t(retention.hasRestitch ? 'launchesRetentionVideo' : 'launchesRetention')}
        >
          <Checkbox
            label={t('launchesSuppress')}
            checked={suppress}
            onChange={setSuppress}
            disabled={locked}
          />
          <Button
            variant="danger"
            disabled={working || generation.busy || (locked && archiveIntent.current === null)}
            onClick={() => void run(() => archive(suppress))}
          >
            {t('launchesArchive')}
          </Button>
          <Button variant="ghost" disabled={locked} onClick={() => setRetention(null)}>
            {t('launchesCancel')}
          </Button>
        </Card>
      )}
      {showProgress && (
        <LaunchGenerationProgress
          teamId={teamId}
          method={draft.config.method ?? 'other'}
          restitchEnabled={draft.config.catalog?.restitchEnabled === true}
          pendingStage={generation.pendingStage ?? (preflighting ? 'validation' : null)}
          requestError={error}
          requestErrorCode={error ? requestErrorCode : null}
          onOpenRestitchSettings={openRestitchSettings}
          onRefresh={detail ? refreshProgress : undefined}
          generation={detail?.generation ?? null}
          disabled={working || !editable}
          onCancel={() => {
            if (preflighting && !generation.busy) preflightAbort.current?.abort();
            else if (generation.hasUnresolvedRequest) void run(generation.cancelPending);
            else if (detail?.generation) void run(() => generation.cancel(detail));
          }}
        />
      )}
      {tab === 'result' && displayedRevision ? (
        <LaunchResult
          launchId={detail?.id}
          revision={displayedRevision}
          settingsChanged={
            !historical &&
            (() => {
              const parsed = parseLaunchConfig(draft.config);
              return !parsed.ok || !launchValuesEqual(parsed.value, displayedRevision.config);
            })()
          }
          onRegenerate={() => void generate()}
          overrides={displayedOverrides}
          onChange={setOverrides}
          editable={editable && !historical}
          disabled={locked}
          onSave={() => {
            if (!active || historical) return;
            const parsed = parseLaunchOverrides(overrides, active.config.campaignCount);
            if (!parsed.ok) {
              setError(t('launchesInvalid'));
              return;
            }
            void run(async () => {
              overridesIntent.current ??= [
                teamId,
                detail!.id,
                active.baselineRevisionId ?? active.id,
                manual.baseVersion ?? detail!.version,
                crypto.randomUUID(),
                parsed.value
              ];
              const intended = overridesIntent.current;
              for (let attempt = 0; ; attempt++) {
                try {
                  await launchMutation(
                    { flowId: intended[4], launchId: intended[1], revisionId: intended[2] },
                    'save_overrides',
                    () => launchApi.overrides(...intended)
                  );
                  break;
                } catch (saveError) {
                  if (
                    saveError instanceof TeamApiError &&
                    saveError.code === 'LAUNCH_VERSION_CONFLICT'
                  ) {
                    const latest = await launchApi.detail(teamId, detail!.id);
                    if (!inputAuthority.current.mounted) return;
                    const merged = mergeLaunchOverrides(
                      active.overrides,
                      overrides,
                      latest.activeRevision?.overrides ?? {}
                    );
                    overridesIntent.current = null;
                    manual.replace(latest);
                    manual.setOverrides(merged);
                    onChange(latest);
                    return;
                  }
                  const definitive =
                    saveError instanceof TeamApiError &&
                    [
                      'FORBIDDEN',
                      'PERMISSION_DENIED',
                      'NOT_FOUND',
                      'INVALID_INPUT',
                      'SOURCE_CHANGED',
                      'LAUNCH_SUB_INVALID'
                    ].includes(saveError.code);
                  if (attempt > 0 || definitive) throw saveError;
                  await new Promise(resolve => window.setTimeout(resolve, 350));
                }
              }
              overridesIntent.current = null;
              const next = await launchApi.detail(teamId, detail!.id);
              if (!inputAuthority.current.mounted) return;
              manual.acknowledge();
              onChange(next);
            });
          }}
        />
      ) : (
        <>
          <LaunchEditor
            teamId={teamId}
            config={draft.config}
            onUploadBusyChange={setUploading}
            submitted={submitted}
            sources={draft.sources}
            onChange={patch => {
              if (
                inputAuthority.current.mounted &&
                !inputAuthority.current.locked &&
                inputAuthority.current.editable
              ) {
                if (patch.method && patch.method !== 'catalog' && catalogSetupMissing) {
                  setCatalogSetupMissing(false);
                  setError(null);
                  setRequestErrorCode(null);
                }
                if ('offerId' in patch) sourceChoice.current.offers++;
                if ('buyerId' in patch) sourceChoice.current.buyers++;
                draft.setConfig(old => ({ ...old, ...patch }));
              }
            }}
            accounts={accounts}
            offers={offers}
            buyers={buyers}
            disabled={!editable || inputLocked || historical}
            onRefreshSources={() => void refreshSources(true)}
            onDictionaryBusyChange={setDictionaryBusy}
            onDictionaryChanged={
              manage
                ? async (kind, removedId, replacement) => {
                    if (removedId) {
                      const field = kind === 'offers' ? 'offerId' : 'buyerId';
                      draft.setConfig(old =>
                        old[field] === removedId ? { ...old, [field]: replacement } : old
                      );
                    }
                    await onDictionaries();
                  }
                : undefined
            }
            onCreate={
              manage
                ? async (kind, value) => {
                    dictionaryRequests.current++;
                    setDictionaryBusy(true);
                    try {
                      const choice = ++sourceChoice.current[kind];
                      const row = await launchApi.createDictionary(
                        teamId,
                        kind,
                        value,
                        crypto.randomUUID()
                      );
                      if (inputAuthority.current.mounted) await onDictionaries();
                      if (
                        !inputAuthority.current.mounted ||
                        inputAuthority.current.locked ||
                        !inputAuthority.current.editable ||
                        sourceChoice.current[kind] !== choice
                      )
                        return;
                      return row.id;
                    } finally {
                      dictionaryRequests.current--;
                      if (inputAuthority.current.mounted)
                        setDictionaryBusy(dictionaryRequests.current > 0);
                    }
                  }
                : undefined
            }
          />
          {editable && (
            <div className="launch-detail-actions flex flex-wrap justify-end gap-2 rounded-control bg-surface p-3">
              {manage && (
                <Button
                  variant="ghost"
                  aria-label={t('launchesDefaults')}
                  disabled={
                    working ||
                    dictionaryBusy ||
                    defaultsConflict ||
                    generation.busy ||
                    (locked && defaultsIntent.current === null)
                  }
                  onClick={() =>
                    void run(async () => {
                      defaultsIntent.current ??= [
                        teamId,
                        defaultsVersion,
                        crypto.randomUUID(),
                        draft.config
                      ];
                      const intended = defaultsIntent.current;
                      const result = await launchMutation(
                        { flowId: intended[2] },
                        'save_defaults',
                        () => launchApi.setDefaults(...intended)
                      );
                      defaultsIntent.current = null;
                      if (!inputAuthority.current.mounted) return;
                      if (
                        result &&
                        typeof result === 'object' &&
                        !Array.isArray(result) &&
                        'version' in result &&
                        typeof result.version === 'string'
                      )
                        setDefaultsVersion(result.version);
                      toasts?.push({ tone: 'success', text: t('launchesDefaultsSaved') });
                    })
                  }
                >
                  <span className="sm:hidden">{t('launchesDefaultsShort')}</span>
                  <span className="hidden sm:inline">{t('launchesDefaults')}</span>
                </Button>
              )}
              <Button
                color="primary"
                variant="solid"
                aria-label={t('launchesGenerate')}
                aria-describedby={preparationStatus ? preparationStatusId : undefined}
                disabled={
                  locked ||
                  historical ||
                  uploading ||
                  dictionaryBusy ||
                  sourcesPending ||
                  sourceChanged ||
                  detail?.generation?.state === 'failed'
                }
                onClick={() => void generate()}
              >
                <span className="sm:hidden">{t('launchesGenerateShort')}</span>
                <span className="hidden sm:inline">{t('launchesGenerate')}</span>
              </Button>
            </div>
          )}
        </>
      )}
      {detail && (
        <div className={tab === 'result' ? 'launch-result-footer' : undefined}>
          <Button
            variant="secondary"
            className="self-start"
            disabled={working}
            aria-expanded={historyOpen}
            onClick={() => {
              if (historyOpen) {
                setHistoryOpen(false);
                return;
              }
              void run(async () => {
                setHistory(await launchApi.history(teamId, detail.id));
                setHistoryOpen(true);
              });
            }}
          >
            <HistoryIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('launchesHistory')}
            <ChevronDown
              className={historyOpen ? 'rotate-180' : ''}
              size={ICON_SIZE}
              aria-hidden="true"
            />
          </Button>
        </div>
      )}
      {historyOpen && (
        <LaunchHistory
          rows={history}
          editable={editable}
          disabled={locked}
          confirming={restoreTarget !== null}
          decisionBusy={working || generationLocked}
          savePending={workingCopyIntent.current !== null}
          onView={onRevision}
          onRestore={id => {
            if (draft.dirty || overridesDirty) setRestoreTarget(id);
            else void run(() => restore(id, false));
          }}
          onSave={() => {
            if (restoreTarget) void run(() => restore(restoreTarget, true));
          }}
          onDiscard={() => {
            if (restoreTarget && !workingCopyIntent.current)
              void run(() => restore(restoreTarget, false));
          }}
          onCancel={() => {
            if (!workingCopyIntent.current) setRestoreTarget(null);
          }}
        />
      )}
    </div>
  );
}
