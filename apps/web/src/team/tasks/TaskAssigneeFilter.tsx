/**
 * Narrowing the board to one person (018, part 2).
 *
 * A pill in the filter row beside the dates, the accounts and the tags. Three
 * kinds of answer: everyone, one member, or the tasks nobody is on — that last
 * one is not "no filter", it is the pile a stand-up is held over, so it gets a
 * line of its own rather than an absent id.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, UserRound, X } from 'lucide-react';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import type { TeamMemberSummary } from '../../api/team';
import type { TaskAssigneeFilter as AssigneeFilter } from './useTasks';

/** What a member is called on screen: their name, else their address, else nothing. */
export function memberLabel(member: TeamMemberSummary): string {
  return member.displayName ?? member.email ?? member.userId;
}

export function TaskAssigneeFilter({
  members,
  value,
  onChange
}: {
  members: readonly TeamMemberSummary[];
  value: AssigneeFilter;
  onChange: (value: AssigneeFilter) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const active = value.kind !== 'all';

  // Opening puts focus on the chosen option, so the arrows work at once.
  useEffect(() => {
    if (!open) return;
    const selected = popover.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    (selected ?? popover.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();
  }, [open]);

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

  const label = (() => {
    if (value.kind === 'unassigned') return t('teamTaskAssigneeFilterNobody');
    if (value.kind === 'member') {
      const member = members.find(item => item.userId === value.userId);
      return member ? memberLabel(member) : t('teamTaskAssigneeFilter');
    }
    return t('teamTaskAssigneeFilter');
  })();

  /** Choosing closes the list and hands focus back to the pill that opened it. */
  const choose = (next: AssigneeFilter) => {
    onChange(next);
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };

  return (
    <div ref={root} className="task-account-filter task-assignee-filter">
      <button
        ref={trigger}
        type="button"
        className={`task-status-filter-option task-account-filter-trigger${active ? ' is-active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('teamTaskAssigneeFilterLabel')}
        onClick={() => setOpen(current => !current)}
      >
        <UserRound size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span>{label}</span>
        {!active && <ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />}
      </button>
      {active && (
        <button
          type="button"
          className="task-date-filter-clear"
          aria-label={t('teamTaskAssigneeFilterClear')}
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
          aria-label={t('teamTaskAssigneeFilterLabel')}
          onKeyDown={onPopoverKeyDown}
        >
          <button
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={value.kind === 'all'}
            className={`task-account-filter-option is-all${value.kind === 'all' ? ' is-selected' : ''}`}
            onClick={() => choose({ kind: 'all' })}
          >
            {t('teamTaskAssigneeFilterEveryone')}
          </button>
          <button
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={value.kind === 'unassigned'}
            className={`task-account-filter-option is-account${value.kind === 'unassigned' ? ' is-selected' : ''}`}
            onClick={() => choose({ kind: 'unassigned' })}
          >
            {t('teamTaskAssigneeFilterNobody')}
          </button>
          {members.length === 0 && (
            <p className="task-account-filter-empty" role="presentation">
              {t('teamTaskAssigneeFilterEmpty')}
            </p>
          )}
          {members.map(member => (
            <button
              key={member.userId}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={value.kind === 'member' && value.userId === member.userId}
              className={`task-account-filter-option is-agent${
                value.kind === 'member' && value.userId === member.userId ? ' is-selected' : ''
              }`}
              onClick={() => choose({ kind: 'member', userId: member.userId })}
            >
              <span className="task-assignee-filter-name">{memberLabel(member)}</span>
              {/* The address only when it is not already the name, so a space
                  of display names does not read as a mailing list. */}
              {member.displayName && member.email && (
                <span className="task-account-filter-note">{member.email}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
