import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { useI18n } from '../i18n';

export type ToastTone = 'success' | 'error' | 'info';

/**
 * A one-shot affordance carried by a toast: Undo for a reversible mutation,
 * Retry for a failed one. The action owns its own outcome reporting — it runs
 * through the same provider, so a toast raised here must not also report on
 * its behalf or every failure would be announced twice.
 */
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastInput {
  tone: ToastTone;
  text: string;
  action?: ToastAction;
  /** Survives the auto-dismiss timer; the reader closes it. */
  sticky?: boolean;
  /**
   * 0–100 while work is in flight, for a toast that reports on something that
   * takes long enough to wonder about — pasting twenty files, say. Omitted for
   * the ordinary one-line outcome.
   */
  progress?: number;
}

export interface ToastMessage extends ToastInput {
  readonly id: number;
}

export interface ToastContextValue {
  toasts: readonly ToastMessage[];
  /** Show a toast; returns its id so a caller can dismiss it early. */
  push: (input: ToastInput) => number;
  /**
   * Change a toast that is already showing — the count as it climbs, and the
   * turn from "copying" into "copied". A running job that raised a new toast
   * per file would bury the screen; this keeps it to one line that moves.
   */
  update: (id: number, patch: Partial<ToastInput>) => void;
  dismiss: (id: number) => void;
}

/* An error has to survive being read after the eye has already moved on, and an
   Undo has to survive a double-take ("wait — did I mean to do that?"), so both
   outlast a plain confirmation. */
const DISMISS_MS: Record<ToastTone, number> = {
  success: 4_000,
  info: 5_000,
  error: 8_000
};
const ACTION_DISMISS_MS = 9_000;

function lifetimeMs(input: ToastInput): number {
  if (input.action) return Math.max(ACTION_DISMISS_MS, DISMISS_MS[input.tone]);
  return DISMISS_MS[input.tone];
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * The single notification channel for team mode: every mutation resolves to
 * exactly one visible outcome here (contracts/ui-conventions.md). It is a
 * provider rather than per-surface state because outcomes have to outlive the
 * surface that started them — a dialog closes, a row unmounts, and the toast
 * still has to be readable.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts(current => current.filter(toast => toast.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = ++nextId.current;
      setToasts(current => [...current, { ...input, id }]);
      if (!input.sticky) {
        timers.current.set(
          id,
          window.setTimeout(() => dismiss(id), lifetimeMs(input))
        );
      }
      return id;
    },
    [dismiss]
  );

  const update = useCallback(
    (id: number, patch: Partial<ToastInput>) => {
      setToasts(current =>
        current.map(toast => (toast.id === id ? { ...toast, ...patch } : toast))
      );
      // A toast that stops being sticky starts its clock now, so "copied" fades
      // like any other confirmation instead of waiting to be closed by hand.
      const stopsBeingSticky = patch.sticky === false;
      if (stopsBeingSticky && !timers.current.has(id)) {
        timers.current.set(
          id,
          window.setTimeout(() => dismiss(id), lifetimeMs({ tone: 'success', text: '', ...patch }))
        );
      }
    },
    [dismiss]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, push, update, dismiss }),
    [dismiss, push, toasts, update]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastRegion({
  toasts,
  onDismiss
}: {
  toasts: readonly ToastMessage[];
  onDismiss: (id: number) => void;
}) {
  const { t } = useI18n();
  if (toasts.length === 0) return null;
  return (
    <div className="ui-toast-region" aria-live="polite" aria-atomic="false">
      {toasts.map(toast => (
        <div key={toast.id} className={`ui-toast ui-toast-${toast.tone}`} role="status">
          <div className="ui-toast-body">
            <p className="ui-toast-text">{toast.text}</p>
            {toast.progress !== undefined && (
              <div
                className="ui-toast-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(toast.progress)}
              >
                <span style={{ width: `${Math.max(0, Math.min(100, toast.progress))}%` }} />
              </div>
            )}
          </div>
          <div className="ui-toast-controls">
            {toast.action && (
              <button
                type="button"
                className="ui-toast-action"
                onClick={() => {
                  const run = toast.action?.run;
                  // Dismiss first: the affordance is one-shot, and leaving it
                  // clickable while the undo is in flight invites a double undo.
                  onDismiss(toast.id);
                  // The action reports its own outcome through this provider.
                  if (run) void Promise.resolve(run()).catch(() => undefined);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              className="ui-toast-dismiss"
              aria-label={t('toastDismiss')}
              onClick={() => onDismiss(toast.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ToastContextOverride({
  value,
  children
}: {
  value: ToastContextValue;
  children: ReactNode;
}) {
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToasts(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToasts must be used inside ToastProvider');
  return value;
}
