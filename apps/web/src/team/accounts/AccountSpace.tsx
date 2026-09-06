/**
 * The Accounts section of a space (017): which agent sits under which account,
 * which of them are free and what is running on the rest.
 *
 * Built as a list to be scanned and marked, not a form to be filled: one row
 * per agent, the free ones first and washed green, a run written in place. The
 * two filters answer the two questions the list is opened for — "where can I
 * start something" and "what is running" — and each drops the accounts that
 * have no answer rather than greying them out.
 *
 * One table, not four: the column captions are printed once above the whole
 * list and stay put while it scrolls, and each account is a heading inside it
 * rather than a card of its own. The counts say what they count — accounts and
 * agents are different numbers, and the chips have only ever meant agents.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, Copy, Eraser, Plus, Search, X } from 'lucide-react';
import {
  buildTeamAgentTopupListByAccount,
  buildTeamAgentTopupListByLabel,
  countTeamAccounts,
  countTeamAgentBalances,
  countTeamAgentTopups,
  filterTeamAccounts,
  sortTeamAccounts,
  sortTeamAgents,
  teamAgentLabel,
  type TeamAccountAgentSummary,
  type TeamAccountMarkerFilter,
  type TeamAccountOccupancyFilter,
  type TeamAgentRun
} from '@video-compressor/shared';
import { Button, IconButton } from '../../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { AccountGroup, AccountNameRow, type AgentEditing } from './AccountGroup';
import { MarkerFilter } from './MarkerFilter';
import { accountCountKey, agentCountKey } from './plural';
import { copyText } from '../../two-factor/clipboard';
import { useTaskLabels, type TaskLabelsClient } from '../labels/useTaskLabels';
import { useAccounts, type AccountsClient } from './useAccounts';

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

export function AccountSpace({ teamId, client }: { teamId: string; client?: AccountSpaceClient }) {
  const { t, language } = useI18n();
  const { push } = useToasts();
  const { can, revision } = useTeam();
  const canEdit = can('edit');
  const accounts = useAccounts({ teamId, revision, client });
  /**
   * The agent half of the space's tag dictionary (019). Read here, beside the
   * accounts, and handed down: every row's tag menu shows the same list, and
   * the copy-out groups by it.
   */
  const agentLabels = useTaskLabels({ teamId, revision, scope: 'agent', client });
  const [search, setSearch] = useState('');
  const [occupancy, setOccupancy] = useState<TeamAccountOccupancyFilter>('all');
  const [marker, setMarker] = useState<TeamAccountMarkerFilter>('all');
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
  const counts = useMemo(
    () => countTeamAccounts(filterTeamAccounts(accounts.accounts, { occupancy: 'all', search })),
    [accounts.accounts, search]
  );
  /** The same two numbers for the whole space, whatever is typed in the search. */
  const totals = useMemo(() => countTeamAccounts(accounts.accounts), [accounts.accounts]);
  /* Each number says "2 of 4" only when that number is the one the search
     narrowed: "3 of 4 accounts · 3 of 3 agents" is true and reads as a bug. */
  const fewerAccounts = counts.accounts !== totals.accounts;
  const fewerAgents = counts.agents !== totals.agents;

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
    const filtered = filterTeamAccounts(accounts.accounts, { occupancy, search, marker });
    if (!editingAccountId || filtered.some(account => account.id === editingAccountId)) {
      return filtered;
    }
    const held = accounts.accounts.find(account => account.id === editingAccountId);
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
  }, [accounts.accounts, editingAccountId, editingAgentRowId, marker, occupancy, search]);

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

  /**
   * The day's top-ups, copied out (019). Two readings of one list: by social
   * account, which is how the person who wrote the figures checks them, and by
   * agent tag, which is how whoever moves the money works through them. Both
   * leave out every agent with nothing to add — the list is the day's work,
   * not the space's inventory.
   */
  const topupCount = countTeamAgentTopups(accounts.accounts);
  const balanceCount = countTeamAgentBalances(accounts.accounts);

  const copyList = (kind: 'names' | 'ids') => {
    const text =
      kind === 'names'
        ? buildTeamAgentTopupListByAccount(accounts.accounts)
        : buildTeamAgentTopupListByLabel(accounts.accounts, t('teamAgentLabelsUntagged'));
    if (text === '') {
      push({ tone: 'info', text: t('teamAccountsCopyEmpty') });
      return;
    }
    void copyText(text).then(ok =>
      push(
        ok
          ? { tone: 'success', text: t('teamAccountsCopied', { count: topupCount }) }
          : { tone: 'error', text: t('teamAgentCopyFailed') }
      )
    );
  };

  /**
   * The two figures, each cleared for its own reason: the top-ups once they
   * have been paid, the balances when a round ends and last round's numbers
   * are noise. Both put what they erased in the toast, so an accidental press
   * is one more press to undo.
   */
  const clearFigures = (kind: 'topups' | 'balances') =>
    void (async () => {
      try {
        const agentsById = new Map(
          accounts.accounts.flatMap(account => account.agents).map(agent => [agent.id, agent])
        );
        const cleared =
          kind === 'topups' ? await accounts.clearTopups() : await accounts.clearBalances();
        if (cleared.length === 0) {
          push({
            tone: 'info',
            text: t(
              kind === 'topups'
                ? 'teamAccountsTopupsAlreadyClear'
                : 'teamAccountsBalancesAlreadyClear'
            )
          });
          return;
        }
        push({
          tone: 'success',
          text: t(kind === 'topups' ? 'teamAccountsTopupsCleared' : 'teamAccountsBalancesCleared', {
            count: cleared.length
          }),
          action: {
            label: t('teamUndo'),
            run: async () => {
              try {
                for (const snapshot of cleared) {
                  const agent = agentsById.get(snapshot.agentRowId);
                  if (!agent) continue;
                  await accounts.setMoney(
                    agent,
                    'balance' in snapshot ? snapshot.balance : agent.balance,
                    'topup' in snapshot ? snapshot.topup : agent.topup
                  );
                }
              } catch (cause) {
                push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
              }
            }
          }
        });
      } catch (cause) {
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      }
    })();

  const listEmpty = !accounts.loading && !accounts.error && accounts.accounts.length === 0;
  const creating = editor?.kind === 'create';

  return (
    <section
      ref={panel}
      className="team-panel team-account-space"
      aria-labelledby="team-accounts-title"
    >
      <div className="team-panel-heading team-account-space-heading">
        <div className="team-account-space-title">
          <h2 id="team-accounts-title">{t('teamAccountsTitle')}</h2>
          {/* The two numbers, apart: the page is called Accounts and the chips
              below count agents, which is a different figure and used to be
              the only one on screen. */}
          {accounts.accounts.length > 0 && (
            <p className="team-accounts-summary">
              {/* Under a search the totals do not quietly become the matches:
                  the page says "2 of 4 accounts", the way the head of an
                  account says "2 of 3 agents" a few pixels below. */}
              <span>
                {fewerAccounts
                  ? t('teamAccountsShownAccounts', {
                      shown: counts.accounts,
                      count: totals.accounts
                    })
                  : t(accountCountKey(language, counts.accounts), { count: counts.accounts })}
              </span>
              <span>
                {fewerAgents
                  ? t('teamAccountsShownAgents', { shown: counts.agents, count: totals.agents })
                  : t(agentCountKey(language, counts.agents), { count: counts.agents })}
              </span>
            </p>
          )}
        </div>
        {canEdit && (
          <Button type="button" variant="primary" data-account-create="true" onClick={startCreate}>
            <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('teamAccountsCreate')}
          </Button>
        )}
      </div>

      {/* The search and the occupancy filter share one row, as the task filters
          do. The pills are the task filter's pills — same class, so the two
          toolbars cannot drift — with a count on each. */}
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
            <span className="team-accounts-occupancy-label" aria-hidden="true">
              {t('teamAccountsFilterInline')}
            </span>
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
            menu — it is the only other thing on this screen about markers. */}
          <MarkerFilter
            value={marker}
            counts={counts.markers}
            total={counts.agents}
            marked={markedRuns}
            canEdit={canEdit}
            onChange={setMarker}
            onClearAll={() => void clearMarkers()}
          />
          {/* The fold, for the whole list: with four accounts open the fourth
            one's rows are a screen away, and folding them one at a time is
            four presses to see what is on the page. */}
          {visible.length > 0 && (
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
              <span>{t(allCollapsed ? 'teamAccountsExpandAll' : 'teamAccountsCollapseAll')}</span>
            </button>
          )}
        </div>
      </div>

      {accounts.loading && accounts.accounts.length === 0 && (
        <p className="team-accounts-notice" aria-live="polite">
          {t('teamAccountsLoading')}
        </p>
      )}
      {accounts.error && <p className="team-inline-error">{t('teamAccountsLoadFailed')}</p>}

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
            <span>{t('teamAccountColumnMoney')}</span>
            <span>{t('teamAccountColumnActions')}</span>
          </div>
          <div className="team-accounts-list">
            {creating && (
              <section className="team-account is-new" aria-label={t('teamAccountsCreate')}>
                <AccountNameRow
                  hold={hold}
                  onDirtyChange={onDirtyChange}
                  onCancel={cancelCreate}
                  onSave={async name => {
                    const created = await accounts.createAccount(name);
                    // The next thing after naming an account is putting an agent
                    // in it, so the agent editor opens without another press.
                    setEditor({ kind: 'account', accountId: created.id, state: { kind: 'add' } });
                    setAccountCollapsed(created.id, false);
                  }}
                />
              </section>
            )}
            {visible.map(account => (
              <AccountGroup
                key={account.id}
                teamId={teamId}
                account={accounts.accounts.find(item => item.id === account.id) ?? account}
                visibleAgents={account.agents}
                canEdit={canEdit}
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
                  requestEditor(state ? { kind: 'account', accountId: account.id, state } : null)
                }
                onRename={name => accounts.renameAccount(account.id, name).then(() => undefined)}
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
                  const created = await accounts.addAgent(account.id, value.agentId, value.note);
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
                onSetMoney={(agent, balance, topup) =>
                  accounts.setMoney(agent, balance, topup).then(() => undefined)
                }
                onToggleLabel={(agent, labelId, next) =>
                  (next
                    ? accounts.attachLabel(agent, labelId)
                    : accounts.detachLabel(agent, labelId)
                  ).then(() => undefined)
                }
                onRelease={release}
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
                      inGroup ?? panel.current?.querySelector<HTMLElement>('[data-account-create]')
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
          {/* Under the list, where a person arrives having filled the figures
              in: the two ways to copy the day's top-ups out, and the way to
              clear them once they are paid. Quiet until there is anything to
              copy — the count on the buttons is the whole state of the thing. */}
          {canEdit && accounts.accounts.length > 0 && (
            <div className="team-accounts-footer">
              <span className="team-accounts-footer-count">
                {topupCount > 0
                  ? t('teamAccountsTopupCount', { count: topupCount })
                  : t('teamAccountsTopupNone')}
              </span>
              <button
                type="button"
                className="team-accounts-footer-action"
                disabled={topupCount === 0}
                onClick={() => copyList('names')}
              >
                <Copy size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
                <span>{t('teamAccountsCopyNames')}</span>
              </button>
              <button
                type="button"
                className="team-accounts-footer-action"
                disabled={topupCount === 0}
                onClick={() => copyList('ids')}
              >
                <Copy size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
                <span>{t('teamAccountsCopyIds')}</span>
              </button>
              <button
                type="button"
                className="team-accounts-footer-action is-danger"
                disabled={topupCount === 0}
                onClick={() => clearFigures('topups')}
              >
                <Eraser size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
                <span>{t('teamAccountsClearTopups')}</span>
              </button>
              {/* The other figure, cleared for its own reason: a round ends and
                  what each agent had is last round's number. */}
              <button
                type="button"
                className="team-accounts-footer-action is-danger"
                disabled={balanceCount === 0}
                onClick={() => clearFigures('balances')}
              >
                <Eraser size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
                <span>{t('teamAccountsClearBalances')}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {listEmpty && !creating && (
        <div className="team-empty-state team-accounts-empty">
          <strong>{t('teamAccountsEmpty')}</strong>
          <p>{t('teamAccountsEmptyBody')}</p>
          {canEdit && (
            <Button type="button" variant="primary" onClick={startCreate}>
              <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('teamAccountsCreate')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
