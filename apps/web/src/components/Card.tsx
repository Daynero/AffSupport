import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';

type CardOwnProps<T extends ElementType> = {
  /** Rendered element; cards are usually landmarks (`section`/`article`). */
  as?: T;
  /** Clickable card: pointer cursor plus the hover raise/lift treatment. */
  interactive?: boolean;
  className?: string;
  children?: ReactNode;
};

export type CardProps<T extends ElementType = 'section'> = CardOwnProps<T> &
  Omit<ComponentPropsWithoutRef<T>, keyof CardOwnProps<T>>;

/**
 * Shared surface primitive behind tool/metric/account/admin/login/landing
 * cards: one `.card` base (border, radius, background, padding on tokens) with
 * per-card modifier classes layered on top for their unique traits.
 */
export function Card<T extends ElementType = 'section'>({
  as,
  interactive = false,
  className = '',
  ...props
}: CardProps<T>) {
  const Tag = (as ?? 'section') as ElementType;
  const classes = `card ${interactive ? 'card-interactive' : ''} ${className}`
    .replace(/\s+/g, ' ')
    .trim();
  return <Tag {...props} className={classes} />;
}
