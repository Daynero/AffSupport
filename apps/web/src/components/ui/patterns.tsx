import { useId, type ReactNode } from 'react';
import { Alert } from './Alert';
import { Button } from './Button';
import { HoldToConfirmButton } from './HoldToConfirmButton';
import { Empty, Skeleton } from './Feedback';
import { Modal } from './Overlay';
import { Toolbar } from './Navigation';
import { uiClasses } from './types';

/**
 * The five shared state patterns (021, T028).
 *
 * A screen does not design its own empty, loading, error, permission-limited or
 * confirmation state — it uses these. That is the whole of user story 2: the
 * states a product either finishes or abandons, finished once.
 *
 * Each is a composition of inventory components and holds no styling of its
 * own beyond layout.
 */

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  /** `h1`/`h2` when the state is the whole screen and needs to be findable. */
  titleAs?: 'strong' | 'h1' | 'h2' | 'h3';
  description?: ReactNode;
  /**
   * The control that resolves the emptiness. A sentence naming where to go is
   * not an action (FR-021) — if there is somewhere to go, this is the door.
   */
  action?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function EmptyState(props: EmptyStateProps) {
  return <Empty {...props} />;
}

export interface LoadingStateProps {
  /** The shape of what is coming, so nothing moves when it lands. */
  shape?: 'text' | 'block' | 'row' | 'tile' | 'circle';
  count?: number;
  /** What is loading, for a reader who cannot see the shimmer. */
  label: string;
  className?: string;
}

export function LoadingState({ shape = 'row', count = 3, label, className }: LoadingStateProps) {
  return <Skeleton shape={shape} count={count} label={label} className={className} />;
}

export interface ErrorStateProps {
  title?: ReactNode;
  /** What went wrong, in the reader's language — not a code. */
  message: ReactNode;
  /** Present when trying again can plausibly work. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({ title, message, onRetry, retryLabel, className }: ErrorStateProps) {
  return (
    <Alert
      color="error"
      variant="soft"
      live="alert"
      title={title}
      className={className}
      action={
        onRetry && (
          <Button size="sm" color="neutral" variant="outline" onClick={onRetry}>
            {retryLabel}
          </Button>
        )
      }
    >
      {message}
    </Alert>
  );
}

export interface PermissionStateProps {
  /** What cannot be done here, and — where it helps — who can do it. */
  message: ReactNode;
  className?: string;
}

/**
 * A surface a role may not act on.
 *
 * The rule is that a control is absent or explained, never present and dead
 * (FR-004 of the state checklist). This is the "explained" half; the absent
 * half is a screen simply not rendering the control.
 */
export function PermissionState({ message, className }: PermissionStateProps) {
  return (
    <Alert color="neutral" variant="subtle" live="none" className={className}>
      {message}
    </Alert>
  );
}

export interface ConfirmDialogProps {
  returnFocus?: HTMLElement | null;
  holdHint?: string;
  alternative?: { label: string; onSelect: () => void };
  open?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: ReactNode;
  /**
   * What will happen. `docs/DESIGN-PRINCIPLES.md`: name the consequence, and
   * put a verb on the button — never "Yes / No".
   */
  body: ReactNode;
  /** The verb: "Delete the space", "Detach storage", "Leave". */
  confirmLabel: string;
  cancelLabel: string;
  /** Destructive is the default here; a benign confirmation says so. */
  tone?: 'destructive' | 'neutral';
  busy?: boolean;
  /** Raised over a dialog that is already open — a delete inside an editor. */
  nested?: boolean;
  /** A dirty editor may put initial focus on keeping the draft. */
  initialFocus?: 'cancel';
}

export function ConfirmDialog({
  returnFocus,
  holdHint,
  alternative,
  open = true,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = 'destructive',
  busy = false,
  nested = false,
  initialFocus
}: ConfirmDialogProps) {
  const bodyId = useId();
  return (
    /* The question is announced with its body (024, T032). It stays a
       `dialog` rather than becoming an `alertdialog`: the workspace's keyboard
       guards (explorer, tasks, launches, accounts) recognise an open overlay by
       `[role="dialog"]`, and a confirmation they did not recognise would let a
       shortcut act on the page behind it. */
    <Modal
      describedBy={bodyId}
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      busy={busy}
      returnFocus={returnFocus}
      nested={nested}
      initialFocus={initialFocus === 'cancel' ? '.ui-confirm-cancel' : undefined}
      footer={
        tone === 'neutral' && !holdHint ? (
          <>
            {/* A benign question: the answer that moves the work forward is the
                primary button, last in the row; keeping things as they are is quiet. */}
            <Button
              className="ui-confirm-cancel"
              color="neutral"
              variant="ghost"
              disabled={busy}
              onClick={onCancel}
            >
              {cancelLabel}
            </Button>
            {alternative && (
              <Button
                color="neutral"
                variant="outline"
                disabled={busy}
                onClick={alternative.onSelect}
              >
                {alternative.label}
              </Button>
            )}
            <Button color="primary" loading={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </>
        ) : (
          <>
            {/* The safe action carries the emphasis and sits where the eye lands
              last; the destructive one is soft and to its left. */}
            {holdHint ? (
              <HoldToConfirmButton disabled={busy} hint={holdHint} onConfirm={onConfirm}>
                {confirmLabel}
              </HoldToConfirmButton>
            ) : (
              <Button
                color={tone === 'destructive' ? 'error' : 'neutral'}
                variant="soft"
                loading={busy}
                onClick={onConfirm}
              >
                {confirmLabel}
              </Button>
            )}
            {alternative && (
              <Button
                color="neutral"
                variant="outline"
                disabled={busy}
                onClick={alternative.onSelect}
              >
                {alternative.label}
              </Button>
            )}
            <Button
              className="ui-confirm-cancel"
              color="neutral"
              variant="outline"
              disabled={busy}
              onClick={onCancel}
            >
              {cancelLabel}
            </Button>
          </>
        )
      }
    >
      <p className="prose" id={bodyId}>
        {body}
      </p>
    </Modal>
  );
}

export interface SelectionBarProps {
  count: number;
  /** "Обрано: 3" — the count, said in the reader's language by the caller. */
  label: ReactNode;
  actions: ReactNode;
  /** Always carries its count: "Clear selection (3)". */
  onClear: () => void;
  clearLabel: string;
  /** The bar's own name for a screen reader; the clear label when not given. */
  toolbarLabel?: string;
  className?: string;
}

/** The strip that appears when rows are selected — explorer, tools, library. */
export function SelectionBar({
  count,
  label,
  actions,
  onClear,
  clearLabel,
  toolbarLabel,
  className
}: SelectionBarProps) {
  if (count === 0) return null;
  return (
    /* On the inventory's Toolbar (024, T032): one Tab stop, the arrows walk the
       actions, and the count is read as the bar's own text. */
    <Toolbar
      label={toolbarLabel ?? clearLabel}
      className={uiClasses('selection-bar', { className })}
    >
      <span className="ui-selection-count">{label}</span>
      <div className="ui-selection-actions">{actions}</div>
      <Button size="sm" color="neutral" variant="ghost" onClick={onClear}>
        {clearLabel}
      </Button>
    </Toolbar>
  );
}
