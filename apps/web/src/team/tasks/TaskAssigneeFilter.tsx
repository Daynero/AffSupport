/**
 * Narrowing the board to one person (018, part 2).
 *
 * A field in the "Filters" panel (024), under the account and above the
 * tags. Three kinds of answer: everyone, one member, or the tasks nobody is
 * on — that last one is not "no filter", it is the pile a stand-up is held
 * over, so it gets a line of its own rather than an absent id.
 */

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { TeamMemberSummary } from '../../api/team';
import type { TaskAssigneeFilter as AssigneeFilter } from './useTasks';
import { SpaceSettingsLink } from '../SpaceSettingsLink';
import { Popover } from '../../components/ui/index';
import { TaskFilterField } from './TaskFilterField';

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

  /** What is in force: a name, "nobody yet", or the word for everyone. */
  const label = (() => {
    if (value.kind === 'unassigned') return t('teamTaskAssigneeFilterNobody');
    if (value.kind === 'member') {
      const member = members.find(item => item.userId === value.userId);
      return member ? memberLabel(member) : t('teamTaskAssigneeFilter');
    }
    return t('teamTaskAssigneeFilterEveryone');
  })();

  /** Choosing closes the list and hands focus back to the pill that opened it. */
  const choose = (next: AssigneeFilter) => {
    onChange(next);
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };

  return (
    <TaskFilterField
      rootRef={root}
      triggerRef={trigger}
      className="task-assignee-filter"
      name={t('teamTaskAssigneeFilter')}
      value={label}
      active={active}
      open={open}
      label={t('teamTaskAssigneeFilterLabel')}
      clearLabel={t('teamTaskAssigneeFilterClear')}
      onToggle={() => setOpen(current => !current)}
      onClear={() => choose({ kind: 'all' })}
    >
      <Popover
        open={open}
        /* Escape and an outside press close onto the trigger, so a keyboard
           is never left inside a menu that is no longer on screen. */
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
        anchor={root}
        placement="bottom-start"
        frequent
        matchWidth
        label={t('teamTaskAssigneeFilterLabel')}
        className="task-filter-field-popover"
      >
        <div
          ref={popover}
          className="task-account-filter-listbox"
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
          {/* Nobody to filter by yet: the sentence says so and the door under
              it opens on the panel where people are invited (FR-021). */}
          {members.length === 0 && (
            <div className="task-account-filter-empty" role="presentation">
              <p>{t('teamTaskAssigneeFilterEmpty')}</p>
              <SpaceSettingsLink
                target={{ kind: 'section', section: 'members' }}
                label={t('teamSectionMembers')}
              />
            </div>
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
      </Popover>
    </TaskFilterField>
  );
}
