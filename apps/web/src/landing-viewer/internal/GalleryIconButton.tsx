import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * An icon control in the viewer's toolbar.
 *
 * The accessible name doubles as a delayed hint (see `.lv-tip`): it appears after a second's
 * hover, never on a click, and never as the browser's own title box.
 */
export function GalleryIconButton({
  label,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      {...props}
      className={`lv-btn lv-tip ${className}`.trim()}
      aria-label={label}
      data-tooltip={label}
      title=""
    >
      {children}
    </button>
  );
}
