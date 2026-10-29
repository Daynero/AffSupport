import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';

export const DESTRUCTIVE_HOLD_MS = 3000;

/** A continuous press, including keyboard presses; a click never confirms. */
export function HoldToConfirmButton({
  children,
  hint,
  disabled = false,
  onConfirm
}: {
  children: ReactNode;
  hint: string;
  disabled?: boolean;
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
        className={`hold-confirm-button${holding ? ' is-holding' : ''}`}
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
          }, DESTRUCTIVE_HOLD_MS);
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
