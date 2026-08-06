import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Action({
  variant = 'secondary',
  reviewId,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  reviewId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      className={`soty-action soty-action-${variant} ${props.className ?? ''}`.trim()}
      data-review-id={reviewId}
      data-demo-action
    >
      {children}
    </button>
  );
}
