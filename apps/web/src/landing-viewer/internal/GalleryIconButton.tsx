import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

/**
 * An icon control in the viewer's toolbar.
 *
 * The accessible name doubles as a delayed hint (see `.lv-tip`): it appears after a second's
 * hover, never on a click, and never as the browser's own title box.
 *
 * Raw on purpose (070 findings, «Фаза 9в», «Фаза 9г»): the toolbar is its own control set —
 * 40px `--lv-control-h`, captioned buttons whose words the toolbar stages fold, pressed
 * view-mode pairs, a CSS hint placed per toolbar group — and moving it onto the inventory is
 * the viewer toolbar's own pass, made on the live viewer at every stage width, not a swap of
 * the element. Only the toolbar uses it: the welcome screen's remove button is the
 * inventory's `IconButton` since 9г.
 */
export function GalleryIconButton({
  label,
  className = '',
  children,
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      {...props}
      ref={ref}
      className={`lv-btn lv-tip ${className}`.trim()}
      aria-label={label}
      data-tooltip={label}
      title=""
    >
      {children}
    </button>
  );
}
