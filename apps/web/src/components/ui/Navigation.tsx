import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { uiClasses, type UiSize } from './types';

/**
 * Navigation (021, T025).
 *
 * Tabs, Breadcrumb, Link and Pagination. The product has four tab strips
 * (workspace sections, settings tabs, task board filters, transcription modes),
 * each with its own active treatment; `docs/DESIGN-PRINCIPLES.md` asks for one,
 * with the active tab unmistakable and an icon beside each label where the
 * label alone is ambiguous.
 */

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  /** A count beside the label — "Tasks 12". */
  badge?: ReactNode;
  disabled?: boolean;
  /**
   * The address this tab *is*, when the sections of a screen are addresses
   * rather than states. Given one, the strip renders links: middle-click,
   * copy-link and Back keep working, and the current one is announced with
   * `aria-current` rather than merely coloured.
   */
  href?: string;
}

export interface TabsProps<T extends string> {
  value: T;
  items: ReadonlyArray<TabItem<T>>;
  onChange: (value: T) => void;
  label: string;
  /** `underline` for a section strip; `pill` for a filter row. */
  variant?: 'underline' | 'pill';
  size?: Extract<UiSize, 'sm' | 'md'>;
  className?: string;
  /** Wires `aria-controls`; the panel carries the matching id. */
  panelId?: (id: T) => string;
  /**
   * Called instead of `onChange` when a tab that is an address is followed, so
   * the caller can keep the navigation in the app for a plain click and let the
   * browser have a modified one.
   */
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, item: TabItem<T>) => void;
}

export function Tabs<T extends string>({
  value,
  items,
  onChange,
  label,
  variant = 'underline',
  size = 'md',
  className,
  panelId,
  onNavigate
}: TabsProps<T>) {
  const enabled = () => items.filter(item => !item.disabled);
  const go = (index: number) => {
    const list = enabled();
    const next = list[((index % list.length) + list.length) % list.length];
    if (!next) return;
    onChange(next.id);
    // The strip is a roving tab stop: the chosen tab is the one Tab reaches,
    // so the arrows have to carry focus with them.
    requestAnimationFrame(() => document.getElementById(`tab-${next.id}`)?.focus());
  };
  const move = (from: T, step: number) => {
    const at = enabled().findIndex(item => item.id === from);
    go(at + step);
  };

  /* A strip of addresses is navigation, not a tablist: a screen reader that is
     told "tab" expects the panel to change without the page doing so. */
  const addresses = items.some(item => item.href !== undefined);
  const Strip = addresses ? 'nav' : 'div';

  return (
    <Strip
      className={uiClasses('tabs', {
        size,
        className: [`ui-tabs--${variant}`, className].filter(Boolean).join(' ')
      })}
      role={addresses ? undefined : 'tablist'}
      aria-label={label}
    >
      {items.map(item =>
        item.href !== undefined ? (
          <a
            key={item.id}
            href={item.href}
            aria-current={item.id === value ? 'page' : undefined}
            className={`ui-tab${item.id === value ? ' is-selected' : ''}`}
            onClick={event => onNavigate?.(event, item)}
          >
            {item.icon && (
              <span className="ui-tab-icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="ui-tab-label">{item.label}</span>
            {item.badge !== undefined && <span className="ui-tab-badge">{item.badge}</span>}
          </a>
        ) : (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={item.id === value}
            aria-controls={panelId?.(item.id)}
            tabIndex={item.id === value ? 0 : -1}
            disabled={item.disabled}
            className={`ui-tab${item.id === value ? ' is-selected' : ''}`}
            onClick={() => onChange(item.id)}
            onKeyDown={event => {
              if (event.key === 'ArrowRight') move(value, 1);
              else if (event.key === 'ArrowLeft') move(value, -1);
              else return;
              event.preventDefault();
            }}
          >
            {item.icon && (
              <span className="ui-tab-icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="ui-tab-label">{item.label}</span>
            {item.badge !== undefined && <span className="ui-tab-badge">{item.badge}</span>}
          </button>
        )
      )}
    </Strip>
  );
}

export interface Crumb {
  id: string;
  label: ReactNode;
  onSelect?: () => void;
}

export interface BreadcrumbProps {
  items: ReadonlyArray<Crumb>;
  label: string;
  className?: string;
}

/** Where you are, and every step back to the root. The last crumb is the page. */
export function Breadcrumb({ items, label, className }: BreadcrumbProps) {
  return (
    <nav className={uiClasses('breadcrumb', { className })} aria-label={label}>
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <span key={item.id} className="ui-breadcrumb-item">
            {index > 0 && (
              <span className="ui-breadcrumb-separator" aria-hidden="true">
                /
              </span>
            )}
            {last || !item.onSelect ? (
              <span aria-current={last ? 'page' : undefined}>{item.label}</span>
            ) : (
              <button type="button" onClick={item.onSelect}>
                {item.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** `standalone` draws it as a control rather than as text in a sentence. */
  variant?: 'inline' | 'standalone';
  leading?: ReactNode;
  trailing?: ReactNode;
}

export function Link({
  variant = 'inline',
  leading,
  trailing,
  className,
  children,
  ...props
}: LinkProps) {
  return (
    <a
      {...props}
      className={uiClasses('link', {
        className: [`ui-link--${variant}`, className].filter(Boolean).join(' ')
      })}
    >
      {leading && (
        <span className="ui-link-leading" aria-hidden="true">
          {leading}
        </span>
      )}
      {children}
      {trailing && (
        <span className="ui-link-trailing" aria-hidden="true">
          {trailing}
        </span>
      )}
    </a>
  );
}

export interface PaginationProps {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  label: string;
  previousLabel: string;
  nextLabel: string;
  className?: string;
}

export function Pagination({
  page,
  pageCount,
  onChange,
  label,
  previousLabel,
  nextLabel,
  className
}: PaginationProps) {
  if (pageCount <= 1) return null;
  return (
    <nav className={uiClasses('pagination', { className })} aria-label={label}>
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {previousLabel}
      </button>
      <span className="ui-pagination-position numeric">
        {page} / {pageCount}
      </span>
      <button type="button" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>
        {nextLabel}
      </button>
    </nav>
  );
}
