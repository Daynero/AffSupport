/**
 * The Accounts section of a space (017): which agent sits under which account,
 * which of them are free and what is running on the rest.
 *
 * Built as a list to be scanned and marked, not a form to be filled: one row
 * per agent, the free ones washed green, a run written in place. The two
 * filters answer the two questions the list is opened for — "where can I
 * start something" and "what is running" — and each drops the accounts that
 * have no answer rather than greying them out.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import {
  countTeamAccounts,
  filterTeamAccounts,
  sortTeamAccounts,
  teamAgentLabel,
  type TeamAccountAgentSummary,
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
import { useAccounts, type AccountsClient } from './useAccounts';

export type AccountSpaceClient = AccountsClient;

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
  const { t } = useI18n();
  const { push } = useToasts();
  const { can, revision } = useTeam();
  const canEdit = can('edit');
  const accounts = useAccounts({ teamId, revision, client });
  const [search, setSearch] = useState('');
  const [occupancy, setOccupancy] = useState<TeamAccountOccupancyFilter>('all');
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
   * The counts on the chips follow the search: with "keto" typed they say how
   * many of the matching agents are free and running, which is the question
   * the chips answer, rather than a total for a list that is not on screen.
   */
  const counts = useMemo(
    () => countTeamAccounts(filterTeamAccounts(accounts.accounts, { occupancy: 'all', search })),
    [accounts.accounts, search]
  );

  /**
   * What the filter leaves — plus the account being edited, whatever the
   * filter says. Under "Running", an account named a moment ago has no agents
   * and would vanish before its first one could be typed.
   */
  const editingAccountId = editor?.kind === 'account' ? editor.accountId : null;
  const visible = useMemo(() => {
    const filtered = filterTeamAccounts(accounts.accounts, { occupancy, search });
    if (!editingAccountId || filtered.some(account => account.id === editingAccountId)) {
      return filtered;
    }
    const held = accounts.accounts.find(account => account.id === editingAccountId);
    return held ? sortTeamAccounts([...filtered, held]) : filtered;
  }, [accounts.accounts, editingAccountId, occupancy, search]);

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

  const listEmpty = !accounts.loading && !accounts.error && accounts.accounts.length === 0;
  const creating = editor?.kind === 'create';

  return (
    <section
      ref={panel}
      className="team-panel team-account-space"
      aria-labelledby="team-accounts-title"
    >
      <div className="team-panel-heading team-account-space-heading">
        <div>
          <p className="team-workspace-eyebrow">{t('teamAccountsEyebrow')}</p>
          <h2 id="team-accounts-title">{t('teamAccountsTitle')}</h2>
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
      </div>

      {accounts.loading && accounts.accounts.length === 0 && (
        <p className="team-accounts-notice" aria-live="polite">
          {t('teamAccountsLoading')}
        </p>
      )}
      {accounts.error && <p className="team-inline-error">{t('teamAccountsLoadFailed')}</p>}

      {(creating || accounts.accounts.length > 0) && (
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
                editingAccountId === account.id && editor?.kind === 'account' ? editor.state : null
              }
              hold={hold && editingAccountId === account.id}
              pendingAgentIds={pendingAgentIds}
              showFreeCount={occupancy !== 'free'}
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
              onRelease={release}
              onDeleteAgent={async agent => {
                await accounts.deleteAgent(agent);
                push({ tone: 'success', text: t('teamAccountsToastAgentDeleted') });
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
