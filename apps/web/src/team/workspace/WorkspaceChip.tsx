import type { MouseEvent, ReactNode } from 'react';

/**
 * The header's chips, as one shape (024, FR-052).
 *
 * Four of them report on the space — the Drive, the catalog updater, the work
 * running in the background, the live connection — and they were four
 * components with four spellings of the same thing. Three were buttons and one
 * was a `<span>`: the realtime chip announced a problem and offered nothing to
 * do about it, which is the one of the four a reader is most likely to want to
 * act on.
 *
 * They differ in what they say and what pressing them does. Everything else —
 * the shape, the spinner, the tone, the fact that it is pressable at all — is
 * here.
 */

export type ChipTone = 'quiet' | 'ok' | 'busy' | 'warn';

const TONE_CLASS: Record<ChipTone, string> = {
  quiet: '',
  ok: 'ui-color-success',
  busy: 'ui-chip-busy ui-color-info',
  warn: 'ui-chip-warn ui-color-warning'
};

export function WorkspaceChip({
  tone = 'quiet',
  busy = false,
  label,
  href,
  onPress,
  className,
  opensDialog = false,
  children
}: {
  tone?: ChipTone;
  /** Draws the spinner: something is happening, not merely true. */
  busy?: boolean;
  /** What pressing it is for, said in full — the chip's own text is short. */
  label: string;
  /** Where it goes, when it goes somewhere: a chip that is a link is a link. */
  href?: string;
  /* Method syntax on purpose: a link's own `MouseEvent<HTMLAnchorElement>`
     handler is accepted as it is, without a cast at the call site. */
  onPress?(event: MouseEvent<HTMLElement>): void;
  className?: string;
  /** Pressing it opens a dialog rather than doing the thing. */
  opensDialog?: boolean;
  children: ReactNode;
}) {
  const classes = ['ui-chip', TONE_CLASS[tone], className].filter(Boolean).join(' ');
  const body = (
    <>
      {busy && <span className="ui-chip-spinner" aria-hidden="true" />}
      {children}
    </>
  );

  if (href) {
    return (
      <a className={classes} href={href} aria-label={label} onClick={onPress}>
        {body}
      </a>
    );
  }
  if (onPress) {
    return (
      <button
        type="button"
        className={classes}
        aria-label={label}
        aria-haspopup={opensDialog ? 'dialog' : undefined}
        aria-live="polite"
        onClick={onPress}
      >
        {body}
      </button>
    );
  }
  /* Nothing to do about it: then it is a status, and says so. */
  return (
    <span className={classes} role="status">
      {body}
    </span>
  );
}
