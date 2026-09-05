/**
 * Picking the agents a task is about (017): account first, then agent.
 *
 * The same dialog the attachment picker is — a path at the top, a list of
 * rows, a check on the chosen ones, one primary button — so tagging a task
 * with an account reads like attaching a file to it. The second level shows
 * whether each agent is free, and a Free/All switch narrows it to the ones a
 * launch could actually go on: that is the question this picker exists for.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Plus, UserRound } from 'lucide-react';
import {
  countTeamAccounts,
  filterTeamAccounts,
  isTeamAgentFree,
  sortTeamAccounts,
  teamAgentIdSuffix,
  teamAgentLabel,
  teamAgentRunsSummary,
  type TeamAccountAgentSummary,
  type TeamAccountOccupancyFilter,
  type TeamAccountSummary
} from '@video-compressor/shared';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { agentCountKey } from '../accounts/AccountGroup';

export interface TaskAccountPickerClient {
  listAccounts(teamId: string): Promise<TeamAccountSummary[]>;
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="m9 5-5 5 5 5M4 10h12"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function TaskAccountPicker({
  teamId,
  client,
  attachedAgentRowIds,
  onAdd,
  onClose
}: {
  teamId: string;
  client: TaskAccountPickerClient;
  /** Agents already on the task; shown checked and not offered twice. */
  attachedAgentRowIds: ReadonlySet<string>;
  /** The chosen agents, with their accounts, in one press of the primary button. */
  onAdd: (agents: { agent: TeamAccountAgentSummary; account: TeamAccountSummary }[]) => void;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const titleId = useId();
  const [accounts, setAccounts] = useState<TeamAccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);
  const [occupancy, setOccupancy] = useState<TeamAccountOccupancyFilter>('all');
  const [selected, setSelected] = useState<Map<string, TeamAccountAgentSummary>>(new Map());

  useEffect(() => {
    let active = true;
    setLoading(true);
    void client
      .listAccounts(teamId)
      .then(value => {
        if (!active) return;
        setAccounts(sortTeamAccounts(value));
        setError(false);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);

  const openAccount = accounts.find(account => account.id === openAccountId) ?? null;
  /**
   * The Free/All switch works at both levels, in the order the owner named
   * them: filter, then account, then agent. Under "Free" an account with no
   * free agent is dropped from the first list — there is nothing to pick in
   * it — and the open account shows only its free agents.
   */
  const shownAccounts = useMemo(
    () =>
      occupancy === 'free'
        ? filterTeamAccounts(accounts, { occupancy: 'free', search: '' }).filter(
            account => account.agents.length > 0
          )
        : accounts,
    [accounts, occupancy]
  );
  const shownAgents = useMemo(() => {
    if (!openAccount) return [];
    const [kept] = filterTeamAccounts([openAccount], { occupancy, search: '' });
    return kept?.agents ?? [];
  }, [occupancy, openAccount]);

  const toggle = (agent: TeamAccountAgentSummary) => {
    setSelected(current => {
      const next = new Map(current);
      if (next.has(agent.id)) next.delete(agent.id);
      else next.set(agent.id, agent);
      return next;
    });
  };

  const add = () => {
    const chosen = [...selected.values()].flatMap(agent => {
      const account = accounts.find(item => item.id === agent.accountId);
      return account ? [{ agent, account }] : [];
    });
    onAdd(chosen);
    onClose();
  };

  return (
    <Modal
      nested
      labelledBy={titleId}
      onClose={onClose}
      closeLabel={t('teamCancel')}
      initialFocus=".team-task-picker-results button, .team-task-account-picker-back"
      size="md"
    >
      <div className="team-task-picker-dialog team-task-account-picker">
        {/* One line of chrome: the title and the Free/All switch. Where you
            are is the second, thin line — only once inside an account. */}
        <div className="team-task-account-picker-heading">
          <h2 id={titleId}>{t('teamTaskAccountPickerTitle')}</h2>
          <div
            className="team-task-account-picker-occupancy"
            role="group"
            aria-label={t('teamAccountsFilterLabel')}
          >
            {(['all', 'free'] as const).map(value => (
              <button
                key={value}
                type="button"
                className={`task-status-filter-option team-accounts-occupancy-option is-${value}${occupancy === value ? ' is-active' : ''}`}
                aria-pressed={occupancy === value}
                onClick={() => setOccupancy(value)}
              >
                {value === 'free' && (
                  <span className="team-accounts-occupancy-dot" aria-hidden="true" />
                )}
                <span>
                  {t(value === 'all' ? 'teamAccountsFilterAll' : 'teamAccountsFilterFree')}
                </span>
              </button>
            ))}
          </div>
        </div>
        {openAccount && (
          <nav className="team-task-account-picker-crumb" aria-label={t('teamAccountsTitle')}>
            <button
              id="team-task-account-picker-root"
              type="button"
              className="team-task-account-picker-back"
              onClick={() => setOpenAccountId(null)}
            >
              <ArrowLeftIcon />
              {t('teamAccountsTitle')}
            </button>
            <i aria-hidden="true">/</i>
            <strong aria-current="page">{openAccount.name}</strong>
          </nav>
        )}

        {loading && <p aria-live="polite">{t('teamAccountsLoading')}</p>}
        {error && <p className="team-inline-error">{t('teamAccountsLoadFailed')}</p>}
        {!loading && !error && accounts.length === 0 && (
          <p className="team-task-picker-empty">{t('teamTaskAccountPickerEmpty')}</p>
        )}

        {!loading &&
          !error &&
          !openAccount &&
          accounts.length > 0 &&
          shownAccounts.length === 0 && (
            <p className="team-task-picker-empty">{t('teamAccountsEmptyFree')}</p>
          )}

        {/* Step one: the accounts, each with what is inside it. */}
        {!loading && !error && !openAccount && shownAccounts.length > 0 && (
          <ul className="team-task-picker-results team-task-picker-folder-results">
            {shownAccounts.map(account => {
              // Counted on the whole account, not the filtered copy: under
              // "Free" the row still says how many agents there are in all.
              const counts = countTeamAccounts([
                accounts.find(item => item.id === account.id) ?? account
              ]);
              const chosenHere = account.agents.filter(agent => selected.has(agent.id)).length;
              return (
                <li key={account.id}>
                  <button type="button" onClick={() => setOpenAccountId(account.id)}>
                    <span className="team-task-picker-item-type" aria-hidden="true">
                      <UserRound size={18} strokeWidth={ICON_STROKE} />
                    </span>
                    <span className="team-task-picker-item-copy">
                      <strong>{account.name}</strong>
                      <small>
                        {counts.agents === 0
                          ? t('teamAccountAgentsNone')
                          : t(agentCountKey(language, counts.agents), { count: counts.agents })}
                        {counts.free > 0 && (
                          <span className="team-task-account-free">
                            {' · '}
                            {t('teamAccountFreeCount', { count: counts.free })}
                          </span>
                        )}
                        {chosenHere > 0 && (
                          <span className="team-task-account-chosen">
                            {' · '}
                            {t('teamTaskAccountPickerChosen', { count: chosenHere })}
                          </span>
                        )}
                      </small>
                    </span>
                    <span className="team-task-picker-check" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Step two: the agents of one account, free ones marked. */}
        {!loading && !error && openAccount && (
          <>
            {shownAgents.length === 0 && (
              <p className="team-task-picker-empty">
                {openAccount.agents.length === 0
                  ? t('teamAccountAgentsNone')
                  : t('teamAccountsEmptyFree')}
              </p>
            )}
            {shownAgents.length > 0 && (
              <ul className="team-task-picker-results">
                {shownAgents.map(agent => {
                  const attached = attachedAgentRowIds.has(agent.id);
                  const chosen = selected.has(agent.id);
                  const free = isTeamAgentFree(agent);
                  return (
                    <li key={agent.id}>
                      <button
                        type="button"
                        className={`${chosen ? 'is-selected' : ''} ${attached ? 'is-attached' : ''} ${free ? 'is-free' : ''}`.trim()}
                        aria-pressed={chosen}
                        disabled={attached}
                        onClick={() => toggle(agent)}
                      >
                        <span
                          className="team-task-picker-item-type team-task-agent-tail"
                          aria-hidden="true"
                        >
                          {teamAgentIdSuffix(agent.agentId)}
                        </span>
                        <span className="team-task-picker-item-copy">
                          <strong>{teamAgentLabel(openAccount.name, agent.agentId)}</strong>
                          <small>
                            {attached
                              ? t('teamTaskAccountAlreadyTagged')
                              : free
                                ? t('teamAgentFree')
                                : teamAgentRunsSummary(agent)}
                          </small>
                        </span>
                        <span className="team-task-picker-check" aria-hidden="true">
                          {attached || chosen ? '✓' : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        <div className="team-dialog-actions team-task-picker-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('teamCancel')}
          </Button>
          <Button type="button" variant="primary" disabled={selected.size === 0} onClick={add}>
            <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('teamTaskAccountPickerAdd', { count: selected.size })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
