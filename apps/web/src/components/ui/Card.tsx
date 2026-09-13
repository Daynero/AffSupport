import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { uiClasses } from './types';

/**
 * Card and Separator (021, T016).
 *
 * The product answered "what is a container" three ways: the compressor's
 * violet-tinted slab under an accent outline, the team space's surface-plus-
 * hairline panel, and the dialog's own card. Feature 020 spent a commit
 * teaching the settings dialog the compressor's answer by hand.
 *
 * Three roles, one anatomy:
 *
 *   surface — a plain container on the page (a list, a results area)
 *   panel   — a group of controls that belong together (the settings slab)
 *   section — a titled block inside a dialog or a longer page
 */

export type CardRole = 'surface' | 'panel' | 'section';

// `title` is a heading here, not the browser's tooltip attribute, so the DOM
// one is dropped rather than narrowed to a string.
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  role?: CardRole;
  /** Renders as <section> with the heading wired to it. */
  as?: 'div' | 'section' | 'article' | 'li' | 'form';
  /** Draws the heading row: icon, title, and whatever the state summary is. */
  icon?: ReactNode;
  title?: ReactNode;
  titleId?: string;
  /** The panel's current state, on the title line — the compressor's summary. */
  aside?: ReactNode;
  /** One sentence under the title, at caption size. */
  description?: ReactNode;
  /** A card that reacts to the pointer because the whole thing is a target. */
  interactive?: boolean;
  selected?: boolean;
}

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  {
    role = 'surface',
    as: Tag = 'div',
    icon,
    title,
    titleId,
    aside,
    description,
    interactive = false,
    selected = false,
    className,
    children,
    ...props
  },
  ref
) {
  const hasHeading = Boolean(icon || title || aside);
  return (
    <Tag
      // The element type is chosen by the caller; the ref type follows it.
      ref={ref as never}
      {...props}
      aria-labelledby={props['aria-labelledby'] ?? (title && titleId ? titleId : undefined)}
      className={uiClasses('card', {
        variant: undefined,
        states: { interactive, selected },
        className: [`ui-card--${role}`, className].filter(Boolean).join(' ')
      })}
    >
      {hasHeading && (
        <div className="ui-card-heading">
          {icon && (
            <span className="ui-card-icon" aria-hidden="true">
              {icon}
            </span>
          )}
          {title && (
            <h2 className="ui-card-title" id={titleId}>
              {title}
            </h2>
          )}
          {aside !== undefined && aside !== null && aside !== false && (
            <span className="ui-card-aside">{aside}</span>
          )}
        </div>
      )}
      {description !== undefined && description !== null && description !== false && (
        <p className="ui-card-description prose">{description}</p>
      )}
      {children}
    </Tag>
  );
});

export interface SeparatorProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
  /** A word in the middle of the line — "or", "then". */
  label?: ReactNode;
}

export function Separator({
  orientation = 'horizontal',
  label,
  className,
  ...props
}: SeparatorProps) {
  return (
    <div
      {...props}
      role="separator"
      aria-orientation={orientation}
      className={uiClasses('separator', {
        states: { labelled: Boolean(label) },
        className: [`ui-separator--${orientation}`, className].filter(Boolean).join(' ')
      })}
    >
      {label && <span className="ui-separator-label">{label}</span>}
    </div>
  );
}
