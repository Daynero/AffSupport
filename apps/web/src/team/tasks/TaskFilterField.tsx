/**
 * One field in the "Filters" panel (024): a name, the value in force, and the
 * way out of it.
 *
 * The account, assignee and tag filters each open their own list, but they
 * are read as one column, so they share one face. It is drawn like the
 * inventory's select — a bordered box the full width of the panel, the
 * value on the right, a caret at the end — and it says what is chosen
 * instead of only what it is for: "Account · Any account" when nothing is,
 * "Account · v31-434" when something is. Once a value is in force the caret
 * gives way to a clear mark, so taking a filter off is one press from where
 * it was put on.
 *
 * The trigger and the clear mark are siblings, not nested: a button inside a
 * button is not a thing a screen reader can announce.
 */

import type { ReactNode, RefObject } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { ICON_STROKE } from '../../components/icons';
import { Button, IconButton } from '../../components/ui/index';

export function TaskFilterField({
  rootRef,
  triggerRef,
  name,
  value,
  marker,
  active,
  open,
  label,
  clearLabel,
  onToggle,
  onClear,
  className,
  popup = 'listbox',
  children
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** What the field is for — "Account", "Tags". */
  name: ReactNode;
  /** What is in force, or the word for "nothing narrowed". */
  value: ReactNode;
  /** A mark drawn before the value — a tag's coloured dot. */
  marker?: ReactNode;
  /** Whether the value narrows the board at all. */
  active: boolean;
  open: boolean;
  /** The trigger's accessible name: the question the field answers. */
  label: string;
  clearLabel: string;
  onToggle: () => void;
  onClear: () => void;
  className?: string;
  /** What the trigger opens: a list to pick from (`listbox`) or a menu of answers (`menu`). */
  popup?: 'listbox' | 'menu';
  /** The list the trigger opens, anchored to the field. */
  children?: ReactNode;
}) {
  return (
    <div
      ref={rootRef}
      className={['task-filter-field', active ? 'is-active' : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      {/* The inventory's button with no face of its own (070, T079): the field draws the box,
          the button takes the press, the focus ring and the disabled look. */}
      <Button
        ref={triggerRef}
        size="sm"
        variant="ghost"
        block
        className="task-filter-field-trigger"
        aria-haspopup={popup}
        aria-expanded={open}
        aria-label={label}
        onClick={onToggle}
      >
        <span className="task-filter-field-name">{name}</span>
        <span className="task-filter-field-value">
          {marker}
          <span className="task-filter-field-text">{value}</span>
        </span>
        {!active && (
          <ChevronDown
            className="task-filter-field-caret"
            size={14}
            strokeWidth={ICON_STROKE}
            aria-hidden="true"
          />
        )}
      </Button>
      {active && (
        <IconButton
          size="xs"
          className="task-filter-field-clear"
          label={clearLabel}
          onClick={onClear}
        >
          <X size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      )}
      {children}
    </div>
  );
}
