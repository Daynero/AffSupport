import { type HTMLAttributes, type ReactNode, type ThHTMLAttributes } from 'react';
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
  /** A count on the right — how many files a folder holds. */
  meta?: ReactNode;
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
  const renderNodes = (list: ReadonlyArray<TreeNode>, depth: number): ReactNode =>
    list.map(node => {
      const expanded = expandedIds.has(node.id);
      const hasChildren = Boolean(node.children?.length);
      return (
        <li
          key={node.id}
          role="treeitem"
          aria-expanded={hasChildren ? expanded : undefined}
          aria-selected={node.id === selectedId}
          className={[
            'ui-tree-item',
            node.id === selectedId ? 'is-selected' : '',
            node.id === dropTargetId ? 'is-drop-target' : ''
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <div className="ui-tree-row" style={{ '--ui-tree-depth': depth } as never}>
            {hasChildren ? (
              <button
                type="button"
                className={`ui-tree-twisty${expanded ? ' is-open' : ''}`}
                aria-label={String(node.label)}
                onClick={() => onToggle(node.id)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path
                    d="m6 4 4 4-4 4"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.6"
                  />
                </svg>
              </button>
            ) : (
              <span className="ui-tree-twisty is-empty" aria-hidden="true" />
            )}
            <button type="button" className="ui-tree-label" onClick={() => onSelect(node.id)}>
              {node.icon && (
                <span className="ui-tree-icon" aria-hidden="true">
                  {node.icon}
                </span>
              )}
              <span>{node.label}</span>
            </button>
            {node.meta !== undefined && <span className="ui-tree-meta numeric">{node.meta}</span>}
          </div>
          {hasChildren && expanded && (
            <ul role="group">{renderNodes(node.children!, depth + 1)}</ul>
          )}
        </li>
      );
    });

  return (
    <ul role="tree" aria-label={label} className={uiClasses('tree', { className })}>
      {renderNodes(nodes, 0)}
    </ul>
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
