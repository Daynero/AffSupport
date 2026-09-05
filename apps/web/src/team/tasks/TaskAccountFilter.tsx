/**
 * Narrowing the task list to one account or one agent (017).
 *
 * A pill in the filter row, beside the dates and the statuses; open, it lists
 * the accounts with their agents nested, free ones marked. The choice goes to
 * the address (`?account=` / `?agent=`), which is also how the Accounts tab's
 * "2 tasks" links land here already narrowed.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import {
  isTeamAgentFree,
  sortTeamAccounts,
  teamAgentRunsSummary,
  teamAgentLabel,
  type TeamAccountSummary
} from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import type { TaskAccountScope } from './useTasks';

export function TaskAccountFilter({
  accounts,
  scope,
  onChange
}: {
  accounts: TeamAccountSummary[];
  scope: TaskAccountScope;
  onChange: (scope: TaskAccountScope) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => sortTeamAccounts(accounts), [accounts]);

  // Opening puts focus on the chosen option, so the arrows work at once.
  useEffect(() => {
    if (!open) return;
    const selected = popover.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    (selected ?? popover.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();
  }, [open]);

  /** ↑/↓ walk the options, Home/End jump: the listbox pattern, not a tab stop each. */
  const onPopoverKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = [...(popover.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    if (options.length === 0) return;
    const index = options.findIndex(option => option === document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(options.length - 1, index + 1)
            : Math.max(0, index - 1);
    event.preventDefault();
    options[next]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  /** What the pill says: the account, the tag, or the neutral word. */
  const label = (() => {
    if (scope.kind === 'account') {
      return (
        accounts.find(account => account.id === scope.accountId)?.name ?? t('teamTaskAccountFilter')
      );
    }
    if (scope.kind === 'agent') {
      for (const account of accounts) {
        const agent = account.agents.find(item => item.id === scope.agentRowId);
        if (agent) return teamAgentLabel(account.name, agent.agentId);
      }
    }
    return t('teamTaskAccountFilter');
  })();
  const active = scope.kind !== 'all';

  /** Choosing closes the list and hands focus back to the pill that opened it. */
  const choose = (next: TaskAccountScope) => {
    onChange(next);
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };

  return (
    <div ref={root} className="task-account-filter">
      <button
        ref={trigger}
        type="button"
        className={`task-status-filter-option task-account-filter-trigger${active ? ' is-active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('teamTaskAccountFilterLabel')}
        onClick={() => setOpen(current => !current)}
      >
        {/* A tag reads in the tag's own face, like every other tag on screen. */}
        <span className={scope.kind === 'agent' ? 'task-account-filter-tag' : undefined}>
          {label}
        </span>
        {/* The chevron gives way to the clear mark once a scope is chosen. */}
        {!active && <ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />}
      </button>
      {active && (
        <button
          type="button"
          className="task-date-filter-clear"
          aria-label={t('teamTaskAccountFilterClear')}
          onClick={() => choose({ kind: 'all' })}
        >
          <X size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      )}
      {open && (
        <div
          ref={popover}
          className="task-date-filter-popover task-account-filter-popover"
          role="listbox"
          aria-label={t('teamTaskAccountFilterLabel')}
          onKeyDown={onPopoverKeyDown}
        >
          <button
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={scope.kind === 'all'}
            className={`task-account-filter-option is-all${scope.kind === 'all' ? ' is-selected' : ''}`}
            onClick={() => choose({ kind: 'all' })}
          >
            {t('teamTaskAccountFilterAll')}
          </button>
          {sorted.length === 0 && (
            <p className="task-account-filter-empty" role="presentation">
              {t('teamTaskAccountPickerEmpty')}
            </p>
          )}
          {sorted.map(account => (
            <div
              key={account.id}
              className="task-account-filter-group"
              role="group"
              aria-label={account.name}
            >
              <button
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={scope.kind === 'account' && scope.accountId === account.id}
                className={`task-account-filter-option is-account${scope.kind === 'account' && scope.accountId === account.id ? ' is-selected' : ''}`}
                onClick={() => choose({ kind: 'account', accountId: account.id })}
              >
                {account.name}
              </button>
              {account.agents.map(agent => (
                <button
                  key={agent.id}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={scope.kind === 'agent' && scope.agentRowId === agent.id}
                  className={`task-account-filter-option is-agent${isTeamAgentFree(agent) ? ' is-free' : ''}${scope.kind === 'agent' && scope.agentRowId === agent.id ? ' is-selected' : ''}`}
                  title={isTeamAgentFree(agent) ? t('teamAgentFree') : teamAgentRunsSummary(agent)}
                  onClick={() => choose({ kind: 'agent', agentRowId: agent.id })}
                >
                  <span className="team-task-agent-chip-dot" aria-hidden="true" />
                  <span className="task-account-filter-tail">
                    {teamAgentLabel(account.name, agent.agentId)}
                  </span>
                  <span className="task-account-filter-note">
                    {isTeamAgentFree(agent) ? t('teamAgentFree') : teamAgentRunsSummary(agent)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
