import { PointerActivationConstraints } from '@dnd-kit/dom';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';

export const ACCOUNT_HOLD_MS = 500;
export const ACCOUNT_HOLD_GRACE_MS = 200;
export interface HoldPoint {
  x: number;
  y: number;
}

/** Follow the sensor's real delay lifecycle, including release and tolerance abort. */
export class AccountHoldConstraint extends PointerActivationConstraints.Delay {
  private feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly present: (point: HoldPoint | null) => void) {
    super({ value: ACCOUNT_HOLD_MS, tolerance: 5 });
  }
  onEvent(event: PointerEvent) {
    if (event.type === 'pointerdown') {
      const point = { x: event.clientX, y: event.clientY };
      this.feedbackTimer = setTimeout(() => {
        this.feedbackTimer = undefined;
        this.present(point);
      }, ACCOUNT_HOLD_GRACE_MS);
    }
    super.onEvent(event);
  }
  private clearFeedback() {
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = undefined;
    this.present(null);
  }
  activate(event: PointerEvent) {
    this.clearFeedback();
    super.activate(event);
  }
  abort() {
    this.clearFeedback();
    super.abort();
  }
}

export function AccountHoldProgress({ point }: { point: HoldPoint }) {
  return createPortal(
    <span
      className="account-hold-progress"
      aria-hidden="true"
      style={{ '--hold-x': `${point.x}px`, '--hold-y': `${point.y}px` } as CSSProperties}
    >
      <svg viewBox="0 0 24 24" fill="none">
        <circle className="account-hold-fill" cx="12" cy="12" r="9" pathLength="1" />
      </svg>
    </span>,
    document.body
  );
}
