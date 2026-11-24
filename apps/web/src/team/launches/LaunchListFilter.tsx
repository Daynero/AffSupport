import { useRef, useState } from 'react';
import { DropdownMenu } from '../../components/ui/index';
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
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
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
      popup="menu"
      onToggle={() => setOpen(current => !current)}
      onClear={() => choose('')}
    >
      {/* The inventory's menu (070, T080): one answer, ticked, with typeahead and the arrows. */}
      <DropdownMenu
        open={open}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
        anchor={root}
        placement="bottom-start"
        matchWidth
        maxHeight={420}
        items={[{ value: '', label: allLabel }, ...options].map(item => ({
          id: item.value === '' ? '__all' : item.value,
          label: item.label,
          checked: value === item.value,
          onSelect: () => choose(item.value)
        }))}
        label={label}
        className="task-filter-field-menu"
      />
    </TaskFilterField>
  );
}
