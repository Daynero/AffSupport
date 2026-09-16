import { Card as HeroCard } from '@heroui/react/card';
import { Separator as HeroSeparator } from '@heroui/react/separator';
import { createElement, type HTMLAttributes, type ReactNode } from 'react';
import { uiClasses } from './types';

/**
 * Card and Separator (021 T016, on HeroUI in 024).
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

export function Card({
  role = 'surface',
  as = 'div',
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
}: CardProps) {
  const hasHeading = Boolean(icon || title || aside);
  return (
    <HeroCard
      {...props}
      aria-labelledby={props['aria-labelledby'] ?? (title && titleId ? titleId : undefined)}
      /* The element is the caller's: a card can be a section, an article, a
         list item or a form, and which it is decides what the document outline
         says. The library's own element override is how that is said. */
      render={rendered => createElement(as, rendered)}
      className={uiClasses('card', {
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
    </HeroCard>
  );
}

export interface SeparatorProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
  /** A word in the middle of the line — "or", "then". */
  label?: ReactNode;
}

/**
 * A line, and — when it is carrying a word — a line that is not a separator.
 *
 * `role="separator"` describes a break with no content. Once there is a word in
 * the middle, the thing on screen is a labelled divider and announcing it as a
 * separator hides the word from anyone listening. So the plain case is the
 * library's, and the labelled case is its own element with the label read.
 */
export function Separator({
  orientation = 'horizontal',
  label,
  className,
  ...props
}: SeparatorProps) {
  const classes = uiClasses('separator', {
    states: { labelled: Boolean(label) },
    className: [`ui-separator--${orientation}`, className].filter(Boolean).join(' ')
  });

  if (!label) {
    return <HeroSeparator {...props} orientation={orientation} className={classes} />;
  }

  return (
    <div {...props} className={classes}>
      <span className="ui-separator-label">{label}</span>
    </div>
  );
}
