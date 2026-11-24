/**
 * Narrowing the task list to one account or one agent (017).
 *
 * A field in the "Filters" panel (024); open, it lists the accounts with
 * their agents nested, free ones marked. The choice goes to the address
 * (`?account=` / `?agent=`), which is also how the Accounts tab's "2 tasks"
 * links land here already narrowed.
 */

import { useMemo, useRef, useState } from 'react';
import {
  isTeamAgentFree,
  sortTeamAccounts,
  teamAgentRunsSummary,
  teamAgentLabel,
  type TeamAccountSummary
} from '@video-compressor/shared';
import { AccountPickerLabel } from '../accounts/AccountPickerLabel';
import { useI18n } from '../../i18n';
import type { TaskAccountScope } from './useTasks';
import { SpaceSettingsLink } from '../SpaceSettingsLink';
import { DropdownMenu, Popover, type MenuEntry } from '../../components/ui/index';
import { TaskFilterField } from './TaskFilterField';

/**
 * What names a scope — the account, or the agent inside it.
 *
 * Exported because the filter bar's chips say the same thing (024): the pill
 * and the chip disagreeing about what the board is narrowed to would be worse
 * than either of them being wrong.
 */
export function taskScopeLabel(
  accounts: readonly TeamAccountSummary[],
  scope: TaskAccountScope,
  fallback: string
): string {
  if (scope.kind === 'account') {
    return accounts.find(account => account.id === scope.accountId)?.name ?? fallback;
  }
  if (scope.kind === 'agent') {
    for (const account of accounts) {
      const agent = account.agents.find(item => item.id === scope.agentRowId);
      if (agent) return teamAgentLabel(account.name, agent.agentId);
    }
  }
  return fallback;
}

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
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => sortTeamAccounts(accounts), [accounts]);

  const active = scope.kind !== 'all';
  /** What is in force: the account, the agent in its own face, or "any". */
  const value = active ? (
    <span className={scope.kind === 'agent' ? 'task-account-filter-tag' : undefined}>
      {taskScopeLabel(accounts, scope, t('teamTaskAccountFilter'))}
    </span>
  ) : (
    t('teamTaskAccountFilterAll')
  );

  /** Choosing closes the list and hands focus back to the pill that opened it. */
  const choose = (next: TaskAccountScope) => {
    onChange(next);
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  /*
   * The inventory's menu (070, T079): one answer out of many, ticked, with typeahead and the
   * arrows from React Aria instead of the hand-walked listbox of buttons this was. An account is
   * an answer and so is each of its agents; a hairline parts one account from the next.
   */
  const items: MenuEntry[] = [
    {
      id: 'all',
      label: t('teamTaskAccountFilterAll'),
      checked: scope.kind === 'all',
      onSelect: () => choose({ kind: 'all' })
    }
  ];
  for (const account of sorted) {
    items.push('separator', {
      id: `account:${account.id}`,
      label: account.name,
      checked: scope.kind === 'account' && scope.accountId === account.id,
      onSelect: () => choose({ kind: 'account', accountId: account.id })
    });
    for (const agent of account.agents) {
      const free = isTeamAgentFree(agent);
      const name = teamAgentLabel(account.name, agent.agentId);
      items.push({
        id: `agent:${agent.id}`,
        ariaLabel: name,
        icon: (
          <span
            className={`team-task-agent-chip-dot${free ? ' is-free' : ''}`}
            aria-hidden="true"
          />
        ),
        label: <AccountPickerLabel name={name} labels={agent.labels} />,
        note: free ? t('teamAgentFree') : teamAgentRunsSummary(agent),
        checked: scope.kind === 'agent' && scope.agentRowId === agent.id,
        onSelect: () => choose({ kind: 'agent', agentRowId: agent.id })
      });
    }
  }

  return (
    <TaskFilterField
      rootRef={root}
      triggerRef={trigger}
      name={t('teamTaskAccountFilter')}
      value={value}
      active={active}
      open={open}
      label={t('teamTaskAccountFilterLabel')}
      clearLabel={t('teamTaskAccountFilterClear')}
      popup={sorted.length === 0 ? 'listbox' : 'menu'}
      onToggle={() => setOpen(current => !current)}
      onClear={() => choose({ kind: 'all' })}
    >
      {sorted.length === 0 ? (
        /* Nothing to pick from: where accounts are made, not an empty menu. */
        <Popover
          open={open}
          onClose={close}
          anchor={root}
          placement="bottom-start"
          frequent
          matchWidth
          label={t('teamTaskAccountFilterLabel')}
          className="task-filter-field-popover"
        >
          <div className="task-account-filter-empty">
            <p>{t('teamTaskAccountPickerEmpty')}</p>
            <SpaceSettingsLink
              target={{ kind: 'section', section: 'accounts' }}
              label={t('teamSectionAccounts')}
            />
          </div>
        </Popover>
      ) : (
        <DropdownMenu
          open={open}
          onClose={close}
          anchor={root}
          placement="bottom-start"
          matchWidth
          maxHeight={420}
          items={items}
          label={t('teamTaskAccountFilterLabel')}
          className="task-filter-field-menu"
        />
      )}
    </TaskFilterField>
  );
}
