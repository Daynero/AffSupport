import { useEffect, useRef, useState } from 'react';
import { Popover } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { TaskFilterField } from '../tasks/TaskFilterField';

export interface LaunchListFilterOption {
  value: string;
  label: string;
}

export function LaunchListFilter({
  label,
  allLabel,
  value,
  options,
  onChange
}: {
  label: string;
  allLabel: string;
  value: string;
  options: readonly LaunchListFilterOption[];
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);

  useEffect(() => {
    if (!open) return;
    const item = [
      ...(popover.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    ].find(option => option.getAttribute('aria-selected') === 'true');
    (item ?? popover.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();
  }, [open]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(popover.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    if (!items.length) return;
    const index = items.findIndex(item => item === document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(items.length - 1, index + 1)
            : Math.max(0, index - 1);
    event.preventDefault();
    items[next]?.focus();
  };

  const option = (item: LaunchListFilterOption, isAll = false) => {
    const active = value === item.value;
    return (
      <button
        key={item.value}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={active}
        className={`task-account-filter-option ${isAll ? 'is-all' : 'is-account'}${active ? ' is-selected' : ''}`}
        onClick={() => choose(item.value)}
      >
        {item.label}
      </button>
    );
  };

  return (
    <TaskFilterField
      rootRef={root}
      triggerRef={trigger}
      name={label}
      value={selected?.label ?? allLabel}
      active={Boolean(value)}
      open={open}
      label={label}
      clearLabel={t('launchesFilterClear', { filter: label })}
      onToggle={() => setOpen(current => !current)}
      onClear={() => choose('')}
    >
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
        anchor={root}
        placement="bottom-start"
        frequent
        matchWidth
        label={label}
        className="task-filter-field-popover"
      >
        <div
          ref={popover}
          className="task-account-filter-listbox"
          role="listbox"
          aria-label={label}
          onKeyDown={onKeyDown}
        >
          {option({ value: '', label: allLabel }, true)}
          {options.map(item => option(item))}
        </div>
      </Popover>
    </TaskFilterField>
  );
}
