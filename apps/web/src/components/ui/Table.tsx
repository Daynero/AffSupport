import {
  Fragment,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type ThHTMLAttributes
} from 'react';
import { uiClasses, type UiSize } from './types';

/**
 * Data surfaces (021, T026).
 *
 * Table, Accordion, Tree, Timeline and User. The product's densest screens —
 * the accounts table, the member list, the audit log — each built their own
 * row; this is that row, with density coming from the size scale rather than
 * from one-off heights. `xs` is the accounts table, which is the reference for
 * how tight this product goes.
 */

export interface TableProps extends HTMLAttributes<HTMLDivElement> {
  size?: Extract<UiSize, 'xs' | 'sm' | 'md'>;
  /** A header that stays while the body scrolls. */
  stickyHeader?: boolean;
  /** Column widths, as a grid template — the row and header share it. */
  columns?: string;
  label?: string;
}

export function Table({
  size = 'sm',
  stickyHeader = false,
  columns,
  label,
  className,
  children,
  ...props
}: TableProps) {
  return (
    <div
      {...props}
      role="table"
      aria-label={label}
      className={uiClasses('table', { size, states: { sticky: stickyHeader }, className })}
      style={columns ? ({ '--ui-table-columns': columns } as never) : undefined}
    >
      {children}
    </div>
  );
}

export function TableHeader({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} role="row" className={uiClasses('table-header', { className })}>
      {children}
    </div>
  );
}

export function TableHeaderCell({
  className,
  children,
  ...props
}: ThHTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} role="columnheader" className={uiClasses('table-header-cell', { className })}>
      {children}
    </div>
  );
}

export interface TableRowProps extends HTMLAttributes<HTMLDivElement> {
  selected?: boolean;
  /** The row itself is the target — a file, an account, a task. */
  interactive?: boolean;
  /** Work is running on this row: it says so without moving. */
  busy?: boolean;
}

export function TableRow({
  selected = false,
  interactive = false,
  busy = false,
  className,
  children,
  ...props
}: TableRowProps) {
  return (
    <div
      {...props}
      role="row"
      aria-selected={selected || undefined}
      aria-busy={busy || undefined}
      className={uiClasses('table-row', {
        states: { selected, interactive, busy },
        className
      })}
    >
      {children}
    </div>
  );
}

export function TableCell({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} role="cell" className={uiClasses('table-cell', { className })}>
      {children}
    </div>
  );
}

export interface AccordionItem {
  id: string;
  title: ReactNode;
  icon?: ReactNode;
  /** The state summary on the title line, as the compressor's panel has. */
  aside?: ReactNode;
  content: ReactNode;
}

export interface AccordionProps {
  items: ReadonlyArray<AccordionItem>;
  openIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  className?: string;
}

export function Accordion({ items, openIds, onToggle, className }: AccordionProps) {
  return (
    <div className={uiClasses('accordion', { className })}>
      {items.map(item => {
        const open = openIds.has(item.id);
        return (
          <div key={item.id} className={`ui-accordion-item${open ? ' is-open' : ''}`}>
            <button
              type="button"
              className="ui-accordion-trigger"
              aria-expanded={open}
              aria-controls={`accordion-${item.id}`}
              onClick={() => onToggle(item.id)}
            >
              {item.icon && (
                <span className="ui-accordion-icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span className="ui-accordion-title">{item.title}</span>
              {item.aside && <span className="ui-accordion-aside">{item.aside}</span>}
              <span className="ui-accordion-chevron" aria-hidden="true">
                <svg viewBox="0 0 16 16" focusable="false">
                  <path
                    d="m4 6 4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.6"
                  />
                </svg>
              </span>
            </button>
            <div id={`accordion-${item.id}`} className="ui-accordion-panel" hidden={!open}>
              {item.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface TreeNode {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** A second line under the label — a state, a path, a count in words. */
  description?: ReactNode;
  /** A count or a glyph on the right — how many files a folder holds. */
  meta?: ReactNode;
  /** A state only this row has: rendering, failed, out of date. */
  className?: string;
  children?: ReadonlyArray<TreeNode>;
}

export interface TreeProps {
  nodes: ReadonlyArray<TreeNode>;
  selectedId?: string | null;
  expandedIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  label: string;
  /** The id currently being dragged over, for a drop target. */
  dropTargetId?: string | null;
  className?: string;
}

/** Every row that is on screen, in the order the arrow keys walk them. */
function visibleRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
}

/**
 * A tree with one tab stop.
 *
 * Two hundred landings were two hundred tab stops before this: the row is the
 * treeitem, the twisty is drawn inside it rather than being a control of its
 * own, and the arrows do what a tree's arrows do — up and down walk the rows
 * that are actually shown, right opens a closed folder or steps into an open
 * one, left closes it or climbs to its parent.
 */
export function Tree({
  nodes,
  selectedId,
  expandedIds,
  onSelect,
  onToggle,
  label,
  dropTargetId,
  className
}: TreeProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches('[role="treeitem"]')) return;
    const rows = visibleRows(event.currentTarget);
    const index = rows.indexOf(target);
    const focus = (next: number) => rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
    const branch = target.dataset.branch;
    const open = target.getAttribute('aria-expanded') === 'true';
    switch (event.key) {
      case 'ArrowDown':
        focus(index + 1);
        break;
      case 'ArrowUp':
        focus(index - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(rows.length - 1);
        break;
      case 'ArrowRight':
        if (branch && !open) onToggle(branch);
        else focus(index + 1);
        break;
      case 'ArrowLeft':
        if (branch && open) onToggle(branch);
        else {
          const parent = target.closest('[role="group"]')?.previousElementSibling;
          if (parent instanceof HTMLElement && parent.matches('[role="treeitem"]')) parent.focus();
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  /* The tab stop: the selection when it is on screen, else the first row. A
     tree nobody can reach from the keyboard is a tree with no tab stop at all,
     which is what `tabIndex={-1}` on every row would leave. */
  const firstId = nodes[0]?.id ?? null;
  const onScreen = (list: ReadonlyArray<TreeNode>): boolean =>
    list.some(
      node =>
        node.id === selectedId ||
        (expandedIds.has(node.id) && node.children ? onScreen(node.children) : false)
    );
  const tabStopId = selectedId && onScreen(nodes) ? selectedId : firstId;

  const renderNodes = (list: ReadonlyArray<TreeNode>, depth: number): ReactNode =>
    list.map(node => {
      const expanded = expandedIds.has(node.id);
      const hasChildren = Boolean(node.children?.length);
      return (
        <Fragment key={node.id}>
          <button
            type="button"
            role="treeitem"
            aria-expanded={hasChildren ? expanded : undefined}
            aria-selected={node.id === selectedId}
            aria-level={depth + 1}
            tabIndex={node.id === tabStopId ? 0 : -1}
            data-branch={hasChildren ? node.id : undefined}
            style={{ '--ui-tree-depth': depth } as never}
            className={[
              'ui-tree-row',
              node.id === selectedId ? 'is-selected' : '',
              node.id === dropTargetId ? 'is-drop-target' : '',
              node.className ?? ''
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => (hasChildren ? onToggle(node.id) : onSelect(node.id))}
          >
            <span
              className={`ui-tree-twisty${hasChildren ? '' : ' is-empty'}${
                expanded ? ' is-open' : ''
              }`}
              aria-hidden="true"
            >
              {hasChildren && (
                <svg viewBox="0 0 16 16" focusable="false">
                  <path
                    d="m6 4 4 4-4 4"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.6"
                  />
                </svg>
              )}
            </span>
            {node.icon && (
              <span className="ui-tree-icon" aria-hidden="true">
                {node.icon}
              </span>
            )}
            <span className="ui-tree-label">
              <span className="ui-tree-name">{node.label}</span>
              {node.description !== undefined && node.description !== null && (
                <small className="ui-tree-description">{node.description}</small>
              )}
            </span>
            {node.meta !== undefined && <span className="ui-tree-meta numeric">{node.meta}</span>}
          </button>
          {hasChildren && expanded && (
            <div role="group">{renderNodes(node.children!, depth + 1)}</div>
          )}
        </Fragment>
      );
    });

  return (
    <div
      role="tree"
      aria-label={label}
      className={uiClasses('tree', { className })}
      onKeyDown={onKeyDown}
    >
      {renderNodes(nodes, 0)}
    </div>
  );
}

export interface TimelineEntry {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  detail?: ReactNode;
  /** The dot's colour role — what kind of event this was. */
  tone?: 'neutral' | 'success' | 'warning' | 'error';
}

export function Timeline({
  entries,
  className
}: {
  entries: ReadonlyArray<TimelineEntry>;
  className?: string;
}) {
  return (
    <ol className={uiClasses('timeline', { className })}>
      {entries.map(entry => (
        <li key={entry.id} className={`ui-timeline-entry is-${entry.tone ?? 'neutral'}`}>
          <span className="ui-timeline-marker" aria-hidden="true" />
          <div className="ui-timeline-body">
            <strong className="ui-timeline-title">{entry.title}</strong>
            {entry.detail && <span className="ui-timeline-detail">{entry.detail}</span>}
            {entry.meta && <span className="ui-timeline-meta">{entry.meta}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface UserProps {
  name: ReactNode;
  meta?: ReactNode;
  avatar?: ReactNode;
  size?: Extract<UiSize, 'xs' | 'sm' | 'md'>;
  className?: string;
}

/** A person, wherever one appears: a member row, an assignee, an audit entry. */
export function User({ name, meta, avatar, size = 'sm', className }: UserProps) {
  return (
    <span className={uiClasses('user', { size, className })}>
      {avatar && <span className="ui-user-avatar">{avatar}</span>}
      <span className="ui-user-copy">
        <span className="ui-user-name">{name}</span>
        {meta && <span className="ui-user-meta">{meta}</span>}
      </span>
    </span>
  );
}
