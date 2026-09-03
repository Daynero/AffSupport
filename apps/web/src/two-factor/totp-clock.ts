/**
 * One clock for every code on the page (feature 016).
 *
 * Codes are shown for every account, always, so the naive version — each row
 * holding its own timer — would be N timers firing at N slightly different
 * moments, N re-renders a second, and rows whose digits change a beat apart.
 *
 * Instead there is one step counter for the whole page. It changes exactly
 * once per thirty seconds, on the boundary, and a row recomputes its digits
 * only when it does. The countdown between those moments is a CSS animation
 * and one small component's own state, so a hundred rows cost nothing to watch.
 */

import { useEffect, useState } from 'react';
import { TOTP_STEP_SECONDS, totpStepEndsAt } from '@video-compressor/shared';

export const STEP_MS = TOTP_STEP_SECONDS * 1000;

export interface TotpStep {
  /** The RFC 6238 counter. Changes once per step; a stable memo key for digits. */
  counter: number;
  /** When this step began, in epoch ms — what codes are computed from. */
  startedAt: number;
}

function stepAt(atMs: number): TotpStep {
  const counter = Math.floor(atMs / STEP_MS);
  return { counter, startedAt: counter * STEP_MS };
}

/**
 * The step the page is in, refreshed on each boundary.
 *
 * The timeout is re-armed from the real clock every time rather than repeating
 * a fixed interval: a laptop that slept through four steps wakes up and lands
 * on the current one, instead of drifting a little further out with each tick.
 */
export function useTotpStep(): TotpStep {
  const [step, setStep] = useState<TotpStep>(() => stepAt(Date.now()));

  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const now = Date.now();
      // A few milliseconds past the boundary, so the new counter is unambiguous.
      timer = window.setTimeout(
        () => {
          setStep(stepAt(Date.now()));
          schedule();
        },
        totpStepEndsAt(now) - now + 20
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  return step;
}

/**
 * Whether the person has stopped touching the page.
 *
 * Codes on screen are a deliberate trade — they live thirty seconds and are
 * single-use, unlike the keys, which stay hidden. But a wallet left open on a
 * shared desk is still a wallet left open, so after a quiet spell the digits
 * blur, and any movement at all brings them back. No control, no setting, and
 * nothing to remember.
 */
export function useIdle(afterMs: number): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), afterMs);
    };
    const events = ['pointermove', 'pointerdown', 'keydown', 'scroll', 'focus'] as const;
    for (const event of events) window.addEventListener(event, wake, { passive: true });
    wake();
    return () => {
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, wake);
    };
  }, [afterMs]);

  return idle;
}
