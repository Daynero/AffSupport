import { useOptionalAuth } from '../../auth/AuthContext';
import { buildTeamRoute } from '../routes';
import { internalLink } from '../../lib/navigation';
/**
 * The Accounts section of a space (017): which agent sits under which account,
 * which of them are free and what is running on the rest.
 *
 * Built as a list to be scanned and marked, not a form to be filled: one row
 * per agent, in persisted manual order, a run written in place. The
 * two filters answer the two questions the list is opened for — "where can I
 * start something" and "what is running" — and each drops the accounts that
 * have no answer rather than greying them out.
 *
 * One table, not four: the column captions are printed once above the whole
 * list and stay put while it scrolls, and each account is a heading inside it
 * rather than a card of its own. The counts say what they count — accounts and
 * agents are different numbers, and the chips have only ever meant agents.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronsDownUp, ChevronsUpDown, Plus, Search, UserRound, X } from 'lucide-react';
import {
  buildFinanceReport,
  financeAgentVisible,
  countTeamAccounts,
  filterTeamAccounts,
  sortTeamAccounts,
  sortTeamAgents,
  TEAM_AGENT_RUN_MARKERS,
  teamAgentLabel,
  type TeamAccountAgentSummary,
  type TeamAccountMarkerFilter,
  type TeamAccountOccupancyFilter,
  type TeamAgentRun
} from '@video-compressor/shared';
import { boundedText, oneOf, persistedViewKey, usePersistedState } from '../persistedView';
import { Button, IconButton } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Empty, ErrorState, LoadingState } from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { AccountGroup, AccountNameRow, type AgentEditing } from './AccountGroup';
import { MarkerFilter } from './MarkerFilter';
import { useTaskLabels, type TaskLabelsClient } from '../labels/useTaskLabels';
import { useAccounts, type AccountsClient } from './useAccounts';
import {
  UnifiedFinanceProvider,
  UnifiedFinanceToolbar,
  UnifiedAgentFinanceFields,
  useUnifiedFinance
} from './finance/UnifiedFinance';
import { AccountReorderProvider, type ReorderRequest } from './AccountReorderProvider';
import { AccountArchiveDrawer } from './AccountArchiveDrawer';
import { useAccountPreferences } from './useAccountPreferences';
import { accountsWorkspaceApi } from '../../api/team-accounts-workspace';
import { accountFlowId, emitAccountSignal } from './analytics';
import { Modal, DropdownMenu } from '../../components/ui/index';
import { MoreHorizontal } from 'lucide-react';
import type { TeamAccountEntityKind } from '@video-compressor/shared';
import { MoveAgentDialog } from './finance/MoveAgentDialog';
import { financeToday } from '@video-compressor/shared';

export type AccountSpaceClient = AccountsClient & TaskLabelsClient;

const OCCUPANCY: readonly TeamAccountOccupancyFilter[] = ['all', 'free', 'busy'];

/**
 * Which accounts are folded, remembered per space in this browser. A
 * convenience, not state: a missing or unreadable value means "all open".
 */
function collapsedKey(teamId: string): string {
  return `soty.team-accounts.collapsed:${teamId}`;
}

function readCollapsed(teamId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(collapsedKey(teamId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(teamId: string, collapsed: Set<string>): void {
  try {
    window.localStorage.setItem(collapsedKey(teamId), JSON.stringify([...collapsed]));
  } catch {
    // Nothing to do: the fold is a convenience and the page works without it.
  }
}

/** Which editor is open: the new-account row, or one row inside one account. */
type Editor = { kind: 'create' } | { kind: 'account'; accountId: string; state: AgentEditing };

type AppliedProof =
  | {
      action: 'lifecycle';
      flowId: string;
      kind: TeamAccountEntityKind;
      id: string;
      version: string;
      archivedAt: string | null;
      view: string;
    }
  | { action: 'reorder'; flowId: string; request: ReorderRequest; version: string; view: string };

export function AccountSpace({ teamId, client }: { teamId: string; client?: AccountSpaceClient }) {
  const { can, revision } = useTeam();
  const auth = useOptionalAuth();
  return (
    <UnifiedFinanceProvider
      key={`${teamId}/${auth?.user?.id ?? 'fixture'}`}
      userId={auth?.user?.id}
      teamId={teamId}
      enabled={!client}
      canEdit={can('edit')}
      revision={revision}
    >
      <AccountSpaceContent teamId={teamId} client={client} />
    </UnifiedFinanceProvider>
  );
}

function AccountSpaceContent({ teamId, client }: { teamId: string; client?: AccountSpaceClient }) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can, revision } = useTeam();
  const canEdit = can('edit');
  const finance = useUnifiedFinance();
  const accounts = useAccounts({
    teamId,
    revision,
    client,
    from: finance.reportRange?.[0] ?? finance.date,
    to: finance.reportRange?.[1] ?? finance.date,
    timezone: finance.timezone
  });
  useEffect(() => {
    finance.setAgentLabels(
      Object.fromEntries(
        accounts.accounts.flatMap(account =>
          account.agents.map(agent => [agent.id, agent.labels.map(label => label.name)])
        )
      )
    );
  }, [accounts.accounts, finance.setAgentLabels]);
  const lifetime = useRef({ active: true, generation: 0 });
  const writePermission = useRef(canEdit);
  writePermission.current = canEdit;
  useEffect(() => {
    lifetime.current.active = true;
    return () => {
      lifetime.current.active = false;
      lifetime.current.generation += 1;
    };
  }, []);
  const [pendingProofs, setPendingProofs] = useState<AppliedProof[]>([]);
  const proofPending = useRef(false);
  const [rowVisibilityRevision, setRowVisibilityRevision] = useState(0);
  const onRowsVisible = useCallback(() => {
    if (proofPending.current) setRowVisibilityRevision(value => value + 1);
  }, []);
  const proofView = JSON.stringify([finance.reportRange, finance.date, finance.timezone]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [archiveTarget, setArchiveTarget] = useState<{
    kind: TeamAccountEntityKind;
    id: string;
    name: string;
    agents: string[];
  } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  useEffect(() => {
    if (!canEdit) {
      setArchiveTarget(null);
      setArchiveBusy(false);
      finance.setFrozenAgents([]);
    }
  }, [canEdit, finance.setFrozenAgents]);
  const fail = useCallback(
    (cause: unknown) => push({ tone: 'error', text: teamErrorMessageFor(cause, t) }),
    [push, t]
  );
  const preferences = useAccountPreferences(
    teamId,
    accounts.accounts.flatMap(account => account.agents),
    cause => {
      fail(cause);
      void accounts.refetch();
    }
  );
  proofPending.current = pendingProofs.length > 0 || preferences.hasPresentationProof;
  const doArchive = async (save: boolean) => {
    const target = archiveTarget;
    if (!target || archiveBusy || !lifetime.current.active || !writePermission.current) return;
    const scope = lifetime.current.generation;
    const current = () =>
      lifetime.current.active && lifetime.current.generation === scope && writePermission.current;
    setArchiveBusy(true);
    setArchiveError('');
    finance.setFrozenAgents(target.agents);
    const flow = accountFlowId();
    try {
      emitAccountSignal('lifecycle', 'draft_resolution', {
        flowId: flow,
        entity: target.kind === 'agent' ? 'rk' : 'social'
      });
      if (save) {
        let summary: { accepted: number; firstFailureCode?: string } | undefined;
        const saved = await finance.saveSubset(target.agents, {
          flowId: flow,
          onSummary: result => {
            summary = result;
          }
        });
        if (!current()) return;
        if (!saved) {
          setArchiveError(t('financeError'));
          emitAccountSignal('lifecycle', 'terminal', {
            flowId: flow,
            outcome: 'failure',
            result: summary && summary.accepted > 0 ? 'partial' : 'failed',
            code: summary?.firstFailureCode ?? 'UNKNOWN',
            count: summary?.accepted ?? 0
          });
          return;
        }
      }
      if (!save) finance.discardSubset(target.agents);
      emitAccountSignal('lifecycle', 'preflight', {
        flowId: flow,
        entity: target.kind === 'agent' ? 'rk' : 'social'
      });
      const before = await accountsWorkspaceApi.preflight(teamId, target.kind, target.id);
      if (!current()) return;
      emitAccountSignal('lifecycle', 'requested', {
        flowId: flow,
        entity: target.kind === 'agent' ? 'rk' : 'social'
      });
      const result = await accountsWorkspaceApi.archive(
        teamId,
        target.kind,
        target.id,
        true,
        before.lifecycleVersion,
        before.token,
        crypto.randomUUID()
      );
      if (!current()) return;
      emitAccountSignal('lifecycle', 'accepted', {
        flowId: flow,
        outcome: 'success',
        result: 'complete'
      });
      setArchiveTarget(null);
      const canonical = await accounts.refetch();
      if (!current()) return;
      finance.refresh();
      if (finance.reportRange) finance.reports.refresh();
      // The overview intentionally includes archived entities. Only the dated
      // projection, rendered with a matching lifecycle snapshot, can prove
      // whether this operation left a visible row.
      if (canonical)
        setPendingProofs(current => [
          ...current,
          {
            action: 'lifecycle',
            flowId: flow,
            kind: target.kind,
            id: target.id,
            version: result.lifecycleVersion,
            archivedAt: result.archivedAt,
            view: proofView
          }
        ]);
      push({
        tone: 'success',
        text: t('accountsArchiveSaved'),
        action: {
          label: t('teamUndo'),
          run: async () => {
            if (!current()) return;
            try {
              await accountsWorkspaceApi.archive(
                teamId,
                target.kind,
                target.id,
                false,
                result.lifecycleVersion,
                result.token,
                crypto.randomUUID()
              );
              if (!current()) return;
              await accounts.refetch();
              if (!current()) return;
              finance.refresh();
              if (finance.reportRange) finance.reports.refresh();
            } catch (cause) {
              if (current()) fail(cause);
            }
          }
        }
      });
    } catch (cause) {
      if (!current()) return;
      setArchiveError(teamErrorMessageFor(cause, t));
      emitAccountSignal('lifecycle', 'terminal', {
        flowId: flow,
        outcome: 'failure',
        result: 'failed',
        code: cause instanceof Error ? cause.message : 'UNKNOWN'
      });
    } finally {
      if (lifetime.current.active && lifetime.current.generation === scope) {
        setArchiveBusy(false);
        finance.setFrozenAgents([]);
      }
    }
  };
  const reorder = async (request: ReorderRequest) => {
    if (!lifetime.current.active || !writePermission.current) return;
    const scope = lifetime.current.generation;
    const current = () =>
      lifetime.current.active && lifetime.current.generation === scope && writePermission.current;
    const flow = request.flowId ?? accountFlowId();
    try {
      emitAccountSignal('reorder', 'requested', {
        flowId: flow,
        entity: request.kind === 'agent' ? 'rk' : 'social'
      });
      const result = await accountsWorkspaceApi.reorder(
        teamId,
        request.kind === 'social' ? 'socials' : 'agents',
        request.parent,
        request.moved,
        request.anchor,
        request.relation,
        request.kind === 'social'
          ? accounts.orderVersions.socials
          : (accounts.orderVersions.agents[request.parent ?? ''] ?? '0'),
        crypto.randomUUID()
      );
      if (!current()) return;
      emitAccountSignal('reorder', 'accepted', {
        flowId: flow,
        outcome: 'success',
        result: 'complete'
      });
      const canonical = await accounts.refetch();
      if (!current()) return;
      if (canonical)
        setPendingProofs(current => [
          ...current,
          {
            action: 'reorder',
            flowId: flow,
            request,
            version: result.version,
            view: proofView
          }
        ]);
    } catch (cause) {
      if (!current()) return;
      await accounts.refetch();
      if (!current()) return;
      fail(cause);
      emitAccountSignal('reorder', 'terminal', {
        flowId: flow,
        outcome: 'failure',
        result: 'conflict',
        code: cause instanceof Error ? cause.message : 'UNKNOWN'
      });
      throw cause;
    }
  };
  /**
   * The agent half of the space's tag dictionary (019). Read here, beside the
   * accounts, and handed down: every row's tag menu shows the same list, and
   * the copy-out groups by it.
   */
  const agentLabels = useTaskLabels({ teamId, revision, scope: 'agent', client });
  const [search, setSearch] = usePersistedState(
    persistedViewKey(teamId, 'accounts.search'),
    '',
    boundedText()
  );
  const [occupancy, setOccupancy] = usePersistedState<TeamAccountOccupancyFilter>(
    persistedViewKey(teamId, 'accounts.occupancy'),
    'all',
    oneOf<TeamAccountOccupancyFilter>(['all', 'free', 'busy'])
  );
  const [marker, setMarker] = usePersistedState<TeamAccountMarkerFilter>(
    persistedViewKey(teamId, 'accounts.marker'),
    'all',
    oneOf<TeamAccountMarkerFilter>(['all', ...TEAM_AGENT_RUN_MARKERS])
  );
  /** One editor at a time, across the whole list. */
  const [editor, setEditor] = useState<Editor | null>(null);
  /**
   * Whether the open editor holds unsaved typing. A ref, because it is read
   * inside click handlers and written by the editor on every keystroke; making
   * it state would re-render the whole list per character for nothing.
   */
  const dirty = useRef(false);
  /** Set when a switch was refused; the open editor shows why. */
  const [hold, setHold] = useState(false);
  /** The agent whose transfer dialog is open, from its row's "…" menu. */
  const [moving, setMoving] = useState<string | null>(null);
  // The transfer dialog only needs who is where; the list already knows.
  const moveSnapshot = useMemo(
    () => ({
      teamId,
      accounts: accounts.accounts.map(account => ({ id: account.id, name: account.name })),
      agents: accounts.accounts.flatMap(account =>
        account.agents.map(agent => ({ id: agent.id, agentId: agent.agentId }))
      ),
      placements: []
    }),
    [accounts.accounts, teamId]
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(teamId));

  useEffect(() => {
    setCollapsed(readCollapsed(teamId));
    setEditor(null);
    setHold(false);
  }, [teamId]);

  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
    if (!value) setHold(false);
  }, []);

  /**
   * Opening another editor while this one has typing in it would throw that
   * typing away without a word. The switch is refused and the open editor says
   * so; Enter or Escape is one keystroke away either way. Closing (`null`) is
   * always allowed — that is Escape itself.
   */
  const requestEditor = useCallback((next: Editor | null) => {
    if (next !== null && dirty.current) {
      setHold(true);
      return;
    }
    setHold(false);
    setEditor(next);
  }, []);

  const setAccountCollapsed = useCallback(
    (accountId: string, value: boolean) => {
      setCollapsed(current => {
        const next = new Set(current);
        if (value) next.add(accountId);
        else next.delete(accountId);
        writeCollapsed(teamId, next);
        return next;
      });
    },
    [teamId]
  );

  /**
   * One press for the whole list. Folded is the exception, so the button says
   * "Collapse all" until every account on screen is already folded — reading
   * the state off what is visible rather than off the remembered set, which
   * may hold accounts the filter has dropped.
   */
  const toggleAll = useCallback(
    (accountIds: readonly string[], fold: boolean) => {
      setCollapsed(current => {
        const next = new Set(current);
        for (const id of accountIds) {
          if (fold) next.add(id);
          else next.delete(id);
        }
        writeCollapsed(teamId, next);
        return next;
      });
    },
    [teamId]
  );

  /**
   * The counts on the chips follow the search: with "keto" typed they say how
   * many of the matching agents are free and running, which is the question
   * the chips answer, rather than a total for a list that is not on screen.
   */
  const periodAccounts = useMemo(() => {
    if (client) return accounts.accounts;
    const snap = finance.reportRange ? finance.reports.snapshot : finance.snapshot;
    const reportMembers =
      snap && finance.reportRange
        ? new Set(
            buildFinanceReport(snap).columns.map(
              column => `${column.accountId}/${column.agentRowId}`
            )
          )
        : null;
    return accounts.accounts
      .map(social => ({
        ...social,
        agents: social.agents.filter(agent => {
          const end = finance.reportRange?.[1] ?? finance.date;
          if (agent.startsOn && agent.startsOn > end) return false;
          if (social.startsOn && social.startsOn > end) return false;
          if (finance.getAffectedDrafts([agent.id]).length > 0) return true;
          if (
            finance.date === finance.today &&
            !finance.reportRange &&
            !social.archivedAt &&
            !agent.archivedAt
          )
            return true;
          if (!snap) return !social.archivedAt && !agent.archivedAt;
          if (finance.reportRange) return reportMembers?.has(`${social.id}/${agent.id}`) ?? false;
          return financeAgentVisible(snap, agent.id, finance.date, finance.timezone, social.id);
        })
      }))
      .filter(
        social =>
          (!social.startsOn || social.startsOn <= (finance.reportRange?.[1] ?? finance.date)) &&
          (social.agents.length > 0 ||
            (!social.archivedAt &&
              accounts.accounts
                .find(item => item.id === social.id)
                ?.agents.every(
                  agent =>
                    agent.startsOn && agent.startsOn > (finance.reportRange?.[1] ?? finance.date)
                )))
      );
  }, [
    accounts.accounts,
    client,
    finance.snapshot,
    finance.reports.snapshot,
    finance.reportRange,
    finance.date,
    finance.timezone,
    finance.drafts.records
  ]);
  const counts = useMemo(
    () => countTeamAccounts(filterTeamAccounts(periodAccounts, { occupancy: 'all', search })),
    [periodAccounts, search]
  );

  /**
   * What the filter leaves — plus the account being edited, whatever the
   * filter says. Under "Running", an account named a moment ago has no agents
   * and would vanish before its first one could be typed.
   */
  const editingAccountId = editor?.kind === 'account' ? editor.accountId : null;
  /** The one agent row an open editor is attached to, if it is attached to one. */
  const editingAgentRowId =
    editor?.kind === 'account' && (editor.state?.kind === 'edit' || editor.state?.kind === 'run')
      ? editor.state.agentRowId
      : null;
  const visible = useMemo(() => {
    const filtered = filterTeamAccounts(periodAccounts, { occupancy, search, marker });
    if (!editingAccountId || filtered.some(account => account.id === editingAccountId)) {
      return filtered;
    }
    const held = periodAccounts.find(account => account.id === editingAccountId);
    if (!held) return filtered;
    /*
     * The account comes back, but not with every agent it owns: the filter's
     * own answer for it, plus the one row being written. Handing over the raw
     * account turned the filter off for that account without saying so — under
     * "Free", the moment a run was assigned the row it was assigned to came
     * back with all its busy neighbours, in server order.
     */
    const kept = filterTeamAccounts([held], { occupancy, search, marker })[0]?.agents ?? [];
    const edited =
      editingAgentRowId && !kept.some(agent => agent.id === editingAgentRowId)
        ? held.agents.filter(agent => agent.id === editingAgentRowId)
        : [];
    const agents = edited.length > 0 ? sortTeamAgents([...kept, ...edited]) : kept;
    return sortTeamAccounts([...filtered, { ...held, agents }]);
  }, [periodAccounts, editingAccountId, editingAgentRowId, marker, occupancy, search]);
  const deferAccountRows =
    periodAccounts.reduce((total, social) => total + social.agents.length, 0) > 100;

  /**
   * How many runs carry a marker anywhere in the space — what "Clear all
   * markers" would take off, and the figure the closed trigger shows. Not the
   * agent count the menu's options use: this one is about the markers
   * themselves.
   */
  const markedRuns = useMemo(
    () =>
      accounts.accounts.reduce(
        (total, account) =>
          total +
          account.agents.reduce(
            (agentTotal, agent) =>
              agentTotal + agent.runs.filter(item => item.marker !== null).length,
            0
          ),
        0
      ),
    [accounts.accounts]
  );

  /** Every account the filter leaves is folded — so the one press unfolds them. */
  const allCollapsed = visible.length > 0 && visible.every(account => collapsed.has(account.id));

  const occupancyCount = (value: TeamAccountOccupancyFilter) =>
    value === 'all' ? counts.agents : value === 'free' ? counts.free : counts.busy;

  const occupancyLabel = (value: TeamAccountOccupancyFilter) =>
    t(
      value === 'all'
        ? 'teamAccountsFilterAll'
        : value === 'free'
          ? 'teamAccountsFilterFree'
          : 'teamAccountsFilterBusy'
    );

  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const surface = panel.current;
    if (!surface?.classList.contains('is-unified')) return;
    // The retained canvas belongs to day navigation. A new search/filter must
    // reveal its results instead of keeping them above the old scroll offset.
    surface.style.removeProperty('min-height');
    surface.querySelector<HTMLElement>('.team-accounts-list')?.style.removeProperty('min-height');
    const table = surface.querySelector<HTMLElement>('.team-accounts-table');
    if (table) table.scrollTop = 0;
  }, [search, occupancy, marker]);
  useEffect(() => {
    preferences.confirmPresentation(panel.current);
  });
  useEffect(() => {
    if (!pendingProofs.length || accounts.loading || accounts.error || !panel.current) return;
    const settled = new Set<AppliedProof>();
    const surface = panel.current;
    const socialElements = [
      ...surface.querySelectorAll<HTMLElement>('.team-account[data-account-id]')
    ];
    const agentElements = [
      ...surface.querySelectorAll<HTMLElement>('.team-agent-row[data-reorder-id]')
    ];
    const snapshot = finance.reportRange ? finance.reports.snapshot : finance.snapshot;
    for (const proof of pendingProofs) {
      if (proof.view !== proofView) continue;
      if (proof.action === 'lifecycle') {
        if (
          !snapshot?.lifecycle ||
          finance.loading ||
          finance.error ||
          (finance.reportRange && (finance.reports.loading || finance.reports.error))
        )
          continue;
        const raw =
          proof.kind === 'social'
            ? accounts.accounts.find(social => social.id === proof.id)
            : accounts.accounts
                .flatMap(social => social.agents)
                .find(agent => agent.id === proof.id);
        const lifecycle =
          proof.kind === 'social'
            ? snapshot.lifecycle.accounts.find(social => social.id === proof.id)
            : snapshot.lifecycle.agents.find(agent => agent.id === proof.id);
        if (
          raw?.lifecycleVersion !== proof.version ||
          raw.archivedAt !== proof.archivedAt ||
          lifecycle?.version !== proof.version ||
          lifecycle.archivedAt !== proof.archivedAt
        )
          continue;
        const retained =
          proof.kind === 'social'
            ? periodAccounts.some(social => social.id === proof.id)
            : periodAccounts.some(social => social.agents.some(agent => agent.id === proof.id));
        const rendered =
          proof.kind === 'social'
            ? socialElements.some(element => element.dataset.accountId === proof.id)
            : agentElements.some(element => element.dataset.reorderId === proof.id);
        // A retained row hidden by a filter or collapsed parent has not been
        // shown. Conversely a stale retained row must disappear before hidden
        // evidence can be emitted.
        if (retained !== rendered) continue;
        emitAccountSignal('lifecycle', 'applied', {
          flowId: proof.flowId,
          outcome: 'success',
          result: retained ? 'retained_period_data' : 'hidden_no_period_data'
        });
      } else {
        const { request } = proof;
        const version =
          request.kind === 'social'
            ? accounts.orderVersions.socials
            : accounts.orderVersions.agents[request.parent ?? ''];
        if (version !== proof.version) continue;
        const rendered =
          request.kind === 'social'
            ? socialElements.map(element => element.dataset.accountId)
            : agentElements
                .filter(
                  element =>
                    element.closest('[data-account-id]')?.getAttribute('data-account-id') ===
                    request.parent
                )
                .map(element => element.dataset.reorderId);
        const moved = rendered.indexOf(request.moved);
        const anchor = rendered.indexOf(request.anchor);
        if (
          moved < 0 ||
          anchor < 0 ||
          (request.relation === 'before' ? moved >= anchor : moved <= anchor)
        )
          continue;
        emitAccountSignal('reorder', 'applied', {
          flowId: proof.flowId,
          outcome: 'success',
          result: 'complete'
        });
      }
      settled.add(proof);
    }
    if (settled.size) setPendingProofs(current => current.filter(proof => !settled.has(proof)));
  }, [
    pendingProofs,
    rowVisibilityRevision,
    accounts.accounts,
    accounts.orderVersions,
    accounts.loading,
    accounts.error,
    periodAccounts,
    proofView,
    finance.snapshot,
    finance.reportRange,
    finance.reports.snapshot,
    finance.reports.loading,
    finance.reports.error,
    finance.loading,
    finance.error,
    visible,
    collapsed
  ]);

  const stickyHeader = useRef<HTMLDivElement>(null);
  const startCreate = () => requestEditor({ kind: 'create' });
  /** Abandoning the name row hands focus back to the button that opened it. */
  const cancelCreate = () => {
    requestEditor(null);
    window.requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>('[data-account-create]')?.focus()
    );
  };

  /** Agents with an undo in flight: their rows wait rather than accept a second press. */
  const [pendingAgentIds, setPendingAgentIds] = useState<ReadonlySet<string>>(() => new Set());
  const markPending = (agentRowId: string, on: boolean) =>
    setPendingAgentIds(current => {
      const next = new Set(current);
      if (on) next.add(agentRowId);
      else next.delete(agentRowId);
      return next;
    });

  const labelOf = (agent: TeamAccountAgentSummary) =>
    teamAgentLabel(
      accounts.accounts.find(account => account.id === agent.accountId)?.name ?? '',
      agent.agentId
    );

  /**
   * Freeing is one press, so it gets an undo: the toast carries the runs that
   * were just erased and writes them back onto the same agent.
   */
  const release = async (agent: TeamAccountAgentSummary) => {
    const before = agent.runs;
    if (before.length === 0) return;
    await accounts.clearRuns(agent);
    push({
      tone: 'success',
      text: t('teamAccountsToastReleased', { tag: labelOf(agent) }),
      action: {
        label: t('teamUndo'),
        run: async () => {
          markPending(agent.id, true);
          try {
            for (const run of before) await accounts.addRun(agent, run.note);
          } catch (cause) {
            push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          } finally {
            markPending(agent.id, false);
          }
        }
      }
    });
  };

  /** Deleting one run gets the same undo. */
  const deleteRun = async (agent: TeamAccountAgentSummary, run: TeamAgentRun) => {
    await accounts.deleteRun(run.id);
    push({
      tone: 'info',
      text: t('teamAccountsToastRunDeleted', { note: run.note }),
      action: {
        label: t('teamUndo'),
        run: async () => {
          markPending(agent.id, true);
          try {
            await accounts.addRun(agent, run.note);
          } catch (cause) {
            push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          } finally {
            markPending(agent.id, false);
          }
        }
      }
    });
  };

  /**
   * Clearing every marker is one press over a lot of marking, so it gets the
   * undo a release gets: the toast carries what each run was and writes the
   * colours back one by one.
   */
  const clearMarkers = async () => {
    const cleared = await accounts.clearMarkers();
    if (cleared.length === 0) return;
    push({
      tone: 'info',
      text: t('teamAccountsToastMarkersCleared', { count: cleared.length }),
      action: {
        label: t('teamUndo'),
        run: async () => {
          try {
            for (const item of cleared) await accounts.setRunMarker(item.runId, item.marker);
          } catch (cause) {
            push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          }
        }
      }
    });
  };

  const listEmpty = !accounts.loading && !accounts.error && accounts.accounts.length === 0;
  const creating = editor?.kind === 'create';
  const showToolbar = !listEmpty;
  const hasStickyHeader = !client || showToolbar;
  // The captions and the finance header stick below the tabs and the toolbar,
  // whose height changes as the toolbar wraps.
  useLayoutEffect(() => {
    const surface = panel.current;
    const header = stickyHeader.current;
    if (!surface) return;
    if (!header) {
      surface.style.removeProperty('--team-accounts-sticky-height');
      return;
    }
    const measure = () =>
      surface.style.setProperty(
        '--team-accounts-sticky-height',
        `${header.getBoundingClientRect().height}px`
      );
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [hasStickyHeader]);

  // Size the independent scroll viewport from its actual document position,
  // including the workspace tabs, heading and any wrapped toolbar rows.
  useLayoutEffect(() => {
    const surface = panel.current;
    if (!surface || client) return;
    const measure = () => {
      const table = surface.querySelector<HTMLElement>('.team-accounts-table');
      if (table) {
        surface.style.setProperty(
          '--team-accounts-table-offset',
          `${table.getBoundingClientRect().top + window.scrollY}px`
        );
      }
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(surface);
    if (surface.parentElement) observer?.observe(surface.parentElement);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      surface.style.removeProperty('--team-accounts-table-offset');
    };
  }, [client, creating, accounts.accounts.length]);

  return (
    <section
      ref={panel}
      className={`team-panel team-account-space${client ? '' : ' is-unified'}`}
      data-account-total-rows={periodAccounts.reduce(
        (total, social) => total + social.agents.length,
        0
      )}
      aria-labelledby="team-accounts-title"
    >
      <div className="team-panel-heading team-account-space-heading">
        <div className="team-account-space-title">
          <h2 id="team-accounts-title">{t('teamAccountsTitle')}</h2>
          {/* No totals line (024): the chips below count agents, and each account's head
              counts its own — a third count under the title said the same numbers again. */}
        </div>
        {/* While the list is empty the empty state carries this same invitation;
            two primaries for one act is one too many (024, FR-092). */}
        <div className="flex items-center gap-2">
          {!client && (
            <>
              <IconButton
                ref={menuAnchor}
                label={t('accountsMenu')}
                onClick={() => setMenuOpen(value => !value)}
              >
                <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} />
              </IconButton>
              <DropdownMenu
                label={t('accountsMenu')}
                open={menuOpen}
                anchor={menuAnchor}
                onClose={() => setMenuOpen(false)}
                items={[
                  {
                    id: 'archive',
                    label: t('accountsArchiveTitle'),
                    icon: <Archive size={ICON_SIZE} />,
                    onSelect: () => {
                      setMenuOpen(false);
                      setArchiveOpen(true);
                    }
                  }
                ]}
              />
            </>
          )}
          {canEdit && !listEmpty && (
            <Button
              type="button"
              variant="primary"
              data-account-create="true"
              onClick={startCreate}
            >
              <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('teamAccountsCreate')}
            </Button>
          )}
        </div>
      </div>

      {/* The tabs, the search and the filters stay on screen while the list
          scrolls under them; the column captions stick just below (measured). */}
      {(!client || showToolbar) && (
        <div ref={stickyHeader} className="team-accounts-sticky">
          <UnifiedFinanceToolbar />
          {/* The search and the occupancy filter share one row, as the task filters
            do. The pills are the task filter's pills — same class, so the two
            toolbars cannot drift — with a count on each. */}
          {/* Nothing to search or filter yet: no toolbar of zeros over the invitation. */}
          {showToolbar && (
            <div className="team-accounts-toolbar">
              <label className="team-accounts-search">
                <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                <input
                  type="search"
                  value={search}
                  aria-label={t('teamAccountsSearchLabel')}
                  placeholder={t('teamAccountsSearchPlaceholder')}
                  onChange={event => setSearch(event.target.value)}
                />
                {search !== '' && (
                  <IconButton
                    title=""
                    label={t('teamAccountsClearField')}
                    tabIndex={-1}
                    onClick={() => setSearch('')}
                  >
                    <X size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  </IconButton>
                )}
              </label>
              {/* The chips have always counted agents, never accounts; now they say
              so out loud rather than only to a screen reader. */}
              <div className="team-accounts-toolbar-end">
                <div
                  className="team-accounts-occupancy"
                  role="group"
                  aria-label={t('teamAccountsFilterLabel')}
                >
                  {OCCUPANCY.map(value => (
                    <button
                      key={value}
                      type="button"
                      className={`task-status-filter-option team-accounts-occupancy-option is-${value}${occupancy === value ? ' is-active' : ''}`}
                      aria-pressed={occupancy === value}
                      onClick={() => setOccupancy(value)}
                    >
                      {value !== 'all' && (
                        <span className="team-accounts-occupancy-dot" aria-hidden="true" />
                      )}
                      <span>{occupancyLabel(value)}</span>
                      <b>{occupancyCount(value)}</b>
                    </button>
                  ))}
                </div>
                {/* The colours, behind one control: they are the filter reached for
              least, and four more chips in this row pushed the fold onto a line
              of its own. Clearing every marker in the space lives in the same
              menu — it is the only other thing on this screen about markers.
              Absent while no run carries a marker (024, FR-092): "Markers 0" was
              a filter with nothing to filter, read as one more thing to learn. */}
                {(markedRuns > 0 || marker !== 'all') && (
                  <MarkerFilter
                    value={marker}
                    counts={counts.markers}
                    total={counts.agents}
                    marked={markedRuns}
                    canEdit={canEdit}
                    onChange={setMarker}
                    onClearAll={() => void clearMarkers()}
                  />
                )}
                {/* The fold, for the whole list: with four accounts open the fourth
              one's rows are a screen away, and folding them one at a time is
              four presses to see what is on the page. */}
                {/* Only with two accounts or more (024): with one, folding everything is the
                  same press as folding its own head. */}
                {visible.length > 1 && (
                  <button
                    type="button"
                    className="team-accounts-fold-all"
                    aria-expanded={!allCollapsed}
                    onClick={() =>
                      toggleAll(
                        visible.map(account => account.id),
                        !allCollapsed
                      )
                    }
                  >
                    {allCollapsed ? (
                      <ChevronsUpDown size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    ) : (
                      <ChevronsDownUp size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    )}
                    <span>
                      {t(allCollapsed ? 'teamAccountsExpandAll' : 'teamAccountsCollapseAll')}
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      <AccountReorderProvider
        onReorder={reorder}
        disabled={!canEdit || Boolean(client) || archiveBusy}
        signature={JSON.stringify([
          accounts.orderVersions,
          visible.map(social => [
            social.id,
            social.archivedAt,
            social.agents.map(agent => [agent.id, agent.archivedAt])
          ])
        ])}
        items={visible.flatMap((social, index) => [
          { kind: 'social' as const, id: social.id, parent: null, label: social.name, index },
          ...social.agents.map((agent, agentIndex) => ({
            kind: 'agent' as const,
            id: agent.id,
            parent: social.id,
            label: agent.agentId,
            index: agentIndex
          }))
        ])}
      >
        <div className="contents">
          {accounts.loading && accounts.accounts.length === 0 && (
            <LoadingState shape="row" count={4} label={t('teamAccountsLoading')} />
          )}
          {accounts.error && (
            <ErrorState
              message={t('teamAccountsLoadFailed')}
              onRetry={() => void accounts.refetch()}
              retryLabel={t('retry')}
            />
          )}

          {!client && accounts.launchCoverage === 'partial' && (
            <p className="text-label text-ink-muted">{t('accountsLaunchPartial')}</p>
          )}
          {(creating || accounts.accounts.length > 0) && (
            <div className="team-accounts-table">
              {/* Printed once, above every account, and left where it is while the
              list scrolls under it. Not hidden from a screen reader either:
              read once at the top it is orientation, which is what it was
              never able to be when every account repeated it. */}
              <div className="team-accounts-columns">
                <span />
                <span>{t('teamAccountColumnAgent')}</span>
                <span>{t('teamAccountColumnStatus')}</span>
                <span>{t('teamAccountColumnRun')}</span>
                {!client && (
                  <div className="unified-finance-headings">
                    <span>{t('financeBalance')}</span>
                    <span>{t('financeTopup')}</span>
                    <span>{t('financeSpend')}</span>
                  </div>
                )}
                {/* Named for a screen reader only; the row's buttons speak for
                themselves, as they do in Airtable and Linear lists. */}
                <span>
                  <span className="visually-hidden">{t('teamAccountColumnActions')}</span>
                </span>
              </div>
              <div className="team-accounts-list" id="team-accounts-list">
                {creating && (
                  <section className="team-account is-new" aria-label={t('teamAccountsCreate')}>
                    <AccountNameRow
                      canSave={canEdit}
                      hold={hold}
                      onDirtyChange={onDirtyChange}
                      onCancel={cancelCreate}
                      onSave={async (name, seed) => {
                        const created = await accounts.createAccount(
                          name,
                          client ? undefined : finance.date
                        );
                        if (!client) {
                          finance.refresh();
                          if (finance.reportRange) finance.reports.refresh();
                        }
                        // The account exists from here on: a refused key is said,
                        // not allowed to strand the editor on a name already taken.
                        if (seed) {
                          try {
                            await accounts.setAccountTwoFactor(created.id, seed);
                          } catch (cause) {
                            push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
                          }
                        }
                        // The next thing after naming an account is putting an agent
                        // in it, so the agent editor opens without another press.
                        setEditor({
                          kind: 'account',
                          accountId: created.id,
                          state: { kind: 'add' }
                        });
                        setAccountCollapsed(created.id, false);
                      }}
                    />
                  </section>
                )}
                {visible.map((account, accountIndex) => (
                  <AccountGroup
                    key={account.id}
                    index={accountIndex}
                    deferRows={deferAccountRows}
                    onRowsVisible={onRowsVisible}
                    reorderEnabled={!client && !archiveBusy}
                    colorOf={preferences.color}
                    onCycleColor={client ? undefined : preferences.cycle}
                    rowLaunches={agent => (
                      <>
                        {accounts.launchSummaries
                          .filter(launch => launch.agentRowId === agent.id)
                          .map(launch => (
                            <a
                              className="account-linked-launch"
                              key={launch.id}
                              href={buildTeamRoute({
                                spaceId: teamId,
                                section: 'launches',
                                query: { launchId: launch.id }
                              })}
                              onClick={event =>
                                internalLink(
                                  event,
                                  buildTeamRoute({
                                    spaceId: teamId,
                                    section: 'launches',
                                    query: { launchId: launch.id }
                                  })
                                )
                              }
                            >
                              {launch.creativeAlias || t('launchesTitle')} ·{' '}
                              {launch.launchDate ?? launch.workStatus}
                            </a>
                          ))}
                      </>
                    )}
                    onHistory={client ? undefined : agent => finance.setHistory(agent.id)}
                    rowFinance={
                      client
                        ? undefined
                        : agent => (
                            <UnifiedAgentFinanceFields
                              agentRowId={agent.id}
                              accountId={agent.accountId}
                              contextLabel={`${account.name} · ${agent.agentId}`}
                            />
                          )
                    }
                    onArchive={
                      client || account.archivedAt
                        ? undefined
                        : agent => {
                            if (dirty.current) {
                              setHold(true);
                              return;
                            }
                            setArchiveError('');
                            setArchiveTarget(
                              agent
                                ? {
                                    kind: 'agent',
                                    id: agent.id,
                                    name: teamAgentLabel(account.name, agent.agentId),
                                    agents: [agent.id]
                                  }
                                : {
                                    kind: 'social',
                                    id: account.id,
                                    name: account.name,
                                    agents: account.agents.map(item => item.id)
                                  }
                            );
                          }
                    }
                    teamId={teamId}
                    account={periodAccounts.find(item => item.id === account.id) ?? account}
                    visibleAgents={account.agents}
                    canEdit={canEdit && !account.archivedAt}
                    collapsed={collapsed.has(account.id)}
                    onCollapsedChange={value => setAccountCollapsed(account.id, value)}
                    editing={
                      editingAccountId === account.id && editor?.kind === 'account'
                        ? editor.state
                        : null
                    }
                    hold={hold && editingAccountId === account.id}
                    pendingAgentIds={pendingAgentIds}
                    search={search}
                    onDirtyChange={onDirtyChange}
                    onEditingChange={state =>
                      requestEditor(
                        state ? { kind: 'account', accountId: account.id, state } : null
                      )
                    }
                    onRename={name =>
                      accounts.renameAccount(account.id, name).then(() => undefined)
                    }
                    onSetTwoFactor={seed => accounts.setAccountTwoFactor(account.id, seed)}
                    onDelete={async () => {
                      await accounts.deleteAccount(account.id);
                      // The section is gone with its buttons; the dialog has nowhere
                      // to return focus to, so it goes to the one control that is
                      // always there.
                      window.requestAnimationFrame(() =>
                        panel.current?.querySelector<HTMLElement>('[data-account-create]')?.focus()
                      );
                    }}
                    onAddAgent={async value => {
                      const created = await accounts.addAgent(
                        account.id,
                        value.agentId,
                        value.note,
                        client ? value.timezone : finance.timezone,
                        client ? undefined : finance.date
                      );
                      if (!client) {
                        finance.refresh();
                        if (finance.reportRange) finance.reports.refresh();
                      }
                      push({
                        tone: 'success',
                        text: t('teamAccountsToastAgentAdded', {
                          tag: teamAgentLabel(account.name, created.agentId)
                        })
                      });
                    }}
                    onUpdateAgent={(agent, agentId) =>
                      accounts.updateAgent(agent, agentId).then(() => undefined)
                    }
                    onAddRun={(agent, note) => accounts.addRun(agent, note).then(() => undefined)}
                    onUpdateRun={(_agent, runId, note) =>
                      accounts.updateRun(runId, note).then(() => undefined)
                    }
                    onDeleteRun={deleteRun}
                    onSetRunMarker={(_agent, item, value) =>
                      accounts.setRunMarker(item.id, value).then(() => undefined)
                    }
                    agentLabels={agentLabels.labels}
                    onToggleLabel={(agent, labelId, next) =>
                      (next
                        ? accounts.attachLabel(agent, labelId)
                        : accounts.detachLabel(agent, labelId)
                      ).then(() => undefined)
                    }
                    onRelease={release}
                    onMoveAgent={
                      canEdit && accounts.accounts.length > 1
                        ? agent => setMoving(agent.id)
                        : undefined
                    }
                    onDeleteAgent={async agent => {
                      await accounts.deleteAgent(agent);
                      push({ tone: 'success', text: t('teamAccountsToastAgentDeleted') });
                      /*
                       * The row is gone and the dialog went with it, so the dialog's own
                       * focus return points at a button that has left the document —
                       * and `focus()` on a detached element is nothing at all. The focus
                       * is handed on here instead, the way deleting an account hands it
                       * back: to the account the agent was in, which is still on screen.
                       */
                      window.requestAnimationFrame(() => {
                        const inGroup = panel.current?.querySelector<HTMLElement>(
                          `[data-account-id="${agent.accountId}"] .team-account-add-agent`
                        );
                        (
                          inGroup ??
                          panel.current?.querySelector<HTMLElement>('[data-account-create]')
                        )?.focus();
                      });
                    }}
                  />
                ))}
                {/* Three distinguishable answers: nothing matches the search, nothing
              is free, nothing is running. Each names the filter in force. */}
                {!creating && visible.length === 0 && accounts.accounts.length > 0 && (
                  <p className="team-accounts-notice">
                    {search.trim() !== ''
                      ? t('teamAccountsEmptySearch', { query: search.trim() })
                      : occupancy === 'free'
                        ? t('teamAccountsEmptyFree')
                        : t('teamAccountsEmptyBusy')}
                  </p>
                )}
              </div>
            </div>
          )}

          {accounts.launchSummaries.some(launch => launch.unmatchedReason) && (
            <section className="account-unmatched-launches">
              <h3>{t('accountsUnmatchedLaunches')}</h3>
              {accounts.launchSummaries
                .filter(launch => launch.unmatchedReason)
                .map(launch => (
                  <a
                    key={launch.id}
                    className="account-linked-launch"
                    href={buildTeamRoute({
                      spaceId: teamId,
                      section: 'launches',
                      query: { launchId: launch.id }
                    })}
                    onClick={event =>
                      internalLink(
                        event,
                        buildTeamRoute({
                          spaceId: teamId,
                          section: 'launches',
                          query: { launchId: launch.id }
                        })
                      )
                    }
                  >
                    {launch.creativeAlias || t('launchesTitle')} · {t('accountsHistorical')}
                  </a>
                ))}
            </section>
          )}
          {listEmpty && !creating && (
            <Empty
              className="team-accounts-empty"
              icon={<UserRound size={26} strokeWidth={ICON_STROKE} aria-hidden="true" />}
              title={t('teamAccountsEmpty')}
              description={t('teamAccountsEmptyBody')}
              action={
                canEdit && (
                  <Button
                    type="button"
                    color="primary"
                    leading={<Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
                    onClick={startCreate}
                  >
                    {t('teamAccountsCreate')}
                  </Button>
                )
              }
            />
          )}
        </div>
      </AccountReorderProvider>
      {archiveOpen && (
        <AccountArchiveDrawer
          teamId={teamId}
          canEdit={canEdit}
          onClose={() => setArchiveOpen(false)}
          onRestore={async () => {
            await accounts.refetch();
            finance.refresh();
          }}
        />
      )}
      {archiveTarget && (
        <Modal
          open
          title={t('accountsArchiveAction', { name: archiveTarget.name })}
          busy={archiveBusy}
          onClose={() => {
            if (!archiveBusy) setArchiveTarget(null);
          }}
          footer={
            <>
              <Button disabled={archiveBusy} onClick={() => setArchiveTarget(null)}>
                {t('financeCancel')}
              </Button>
              {finance.getAffectedDrafts(archiveTarget.agents).length > 0 ? (
                <>
                  <Button
                    color="error"
                    variant="ghost"
                    disabled={archiveBusy}
                    onClick={() => void doArchive(false)}
                  >
                    {t('accountsDiscardArchive')}
                  </Button>
                  <Button
                    color="success"
                    loading={archiveBusy}
                    onClick={() => void doArchive(true)}
                  >
                    {t('accountsSaveArchive')}
                  </Button>
                </>
              ) : (
                <Button
                  color="secondary"
                  loading={archiveBusy}
                  onClick={() => void doArchive(true)}
                >
                  {t('accountsArchive')}
                </Button>
              )}
            </>
          }
        >
          <p>
            {t(
              finance.getAffectedDrafts(archiveTarget.agents).length > 0
                ? 'accountsDraftArchive'
                : 'accountsArchiveBody'
            )}
          </p>
          {archiveError && (
            <p className="field-error" role="alert">
              {archiveError}
            </p>
          )}
        </Modal>
      )}
      {moving && (
        <MoveAgentDialog
          snapshot={moveSnapshot}
          agent={moving}
          today={financeToday(Intl.DateTimeFormat().resolvedOptions().timeZone)}
          timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          onClose={() => setMoving(null)}
          onMoved={() => void accounts.refetch()}
        />
      )}
    </section>
  );
}
