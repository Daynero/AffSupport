import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';

export const DESTRUCTIVE_HOLD_MS = 3000;
/**
 * Deleting a whole space (2026-11-25): long enough to be a decision rather than a
 * reflex, as the owner asked. Mirrors `--motion-space-delete-hold`.
 */
export const SPACE_DELETE_HOLD_MS = 5000;

const HOLD_MS = { destructive: DESTRUCTIVE_HOLD_MS, space: SPACE_DELETE_HOLD_MS } as const;
export type HoldDuration = keyof typeof HOLD_MS;

/** A continuous press, including keyboard presses; a click never confirms. */
export function HoldToConfirmButton({
  children,
  hint,
  disabled = false,
  duration = 'destructive',
  onConfirm
}: {
  children: ReactNode;
  hint: string;
  disabled?: boolean;
  /** How long the press must last; each length has its own token for the fill. */
  duration?: HoldDuration;
  onConfirm: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const hintId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(false);
  const latest = useRef({ disabled, onConfirm });
  latest.current = { disabled, onConfirm };
  const stop = useCallback(() => {
    clearTimeout(timer.current);
    active.current = false;
    setHolding(false);
  }, []);
  useEffect(() => {
    const cancelHidden = () => {
      if (document.hidden) stop();
    };
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', cancelHidden);
    return () => {
      clearTimeout(timer.current);
      active.current = false;
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', cancelHidden);
    };
  }, [stop]);
  useEffect(() => {
    if (disabled) stop();
  }, [disabled, stop]);
  return (
    <div className="hold-confirm-control">
      <Button
        color="error"
        variant="outline"
        disabled={disabled}
        className={`hold-confirm-button${duration === 'space' ? ' is-long' : ''}${holding ? ' is-holding' : ''}`}
        aria-describedby={hintId}
        onBlur={stop}
        onPressStart={event => {
          if (event.pointerType === 'virtual' || latest.current.disabled || active.current) return;
          active.current = true;
          setHolding(true);
          timer.current = setTimeout(() => {
            if (!active.current || latest.current.disabled || document.hidden) return;
            setHolding(false);
            latest.current.onConfirm();
          }, HOLD_MS[duration]);
        }}
        onPressEnd={stop}
      >
        <span className="hold-confirm-fill" aria-hidden="true" />
        <span className="hold-confirm-label">{children}</span>
      </Button>
      <small id={hintId} className="hold-confirm-hint">
        {hint}
      </small>
    </div>
  );
}
