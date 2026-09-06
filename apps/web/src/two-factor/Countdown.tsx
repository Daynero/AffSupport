/**
 * How long every code on the page has left (feature 016).
 *
 * One indicator for the whole table rather than one per row: the codes all
 * turn over together, so a countdown beside each of them would be the same
 * number repeated as many times as there are accounts, and as many timers.
 *
 * It sits directly above the column of digits it governs, which is the only
 * placement that needs no explaining.
 *
 * The bar is a CSS animation, not React state — it re-syncs once per step with
 * a negative delay and then runs on the compositor, so watching a hundred codes
 * drain costs nothing. Only the number re-renders, and only this component.
 */

import { useEffect, useMemo, useState } from 'react';
import { TOTP_STEP_SECONDS } from '@video-compressor/shared';
import { useI18n } from '../i18n';
import { STEP_MS, type TotpStep } from './totp-clock';

/**
 * What is left of the step the clock is in — read from the clock itself, not
 * from the step the page last noticed.
 *
 * The difference matters exactly when the page was not being watched: a tab
 * whose timers were throttled comes back holding a step that ended a minute
 * ago, and a countdown computed from it read nonsense — a number from the
 * middle of a step that was already over. Asked of the clock, the number is
 * true even in the moment before the page has caught up.
 */
function secondsLeft(): number {
  const now = Date.now();
  return Math.max(0, Math.ceil((Math.ceil(now / STEP_MS) * STEP_MS - now) / 1000));
}

export function Countdown({ step }: { step: TotpStep }) {
  const { t } = useI18n();
  const [seconds, setSeconds] = useState(secondsLeft);

  useEffect(() => {
    const tick = () => setSeconds(secondsLeft());
    tick();
    const timer = window.setInterval(tick, 250);
    // Coming back to the tab must not wait for the next tick: the number on
    // screen is a promise about how long the digits beside it are good for.
    const wake = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [step]);

  /*
   * Negative delay drops the animation in at the position the current step is
   * already at, so a page opened mid-step shows the truth immediately.
   *
   * Computed once per step, and this is the whole point of the memo. Read on
   * every render it was a second offset applied to an animation that had
   * already advanced by the same amount: the bar ran at double speed and
   * emptied in fifteen seconds while the number beside it counted thirty. The
   * delay is the position the bar *started* from; the compositor does the rest.
   */
  const elapsed = useMemo(
    () => Math.min(Math.max(Date.now() - step.startedAt, 0), STEP_MS),
    [step]
  );

  return (
    <div
      className="tfa-countdown"
      role="progressbar"
      aria-label={t('twoFactorCodeLife', { seconds })}
      aria-valuenow={seconds}
      aria-valuemin={0}
      aria-valuemax={TOTP_STEP_SECONDS}
    >
      {/* The number first and the bar after it: the bar is the long thing, and
          it ends on the same line the digits under it end on. */}
      <span className="tfa-countdown-seconds">{t('twoFactorSecondsLeft', { seconds })}</span>
      <span className="tfa-countdown-track">
        <span
          key={step.counter}
          className="tfa-countdown-fill"
          style={{ animationDelay: `-${elapsed}ms` }}
        />
      </span>
    </div>
  );
}
