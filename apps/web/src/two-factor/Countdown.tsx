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

import { useEffect, useState } from 'react';
import { TOTP_STEP_SECONDS } from '@video-compressor/shared';
import { useI18n } from '../i18n';
import { STEP_MS, type TotpStep } from './totp-clock';

export function Countdown({ step }: { step: TotpStep }) {
  const { t } = useI18n();
  const [seconds, setSeconds] = useState(() =>
    Math.max(0, Math.ceil((step.startedAt + STEP_MS - Date.now()) / 1000))
  );

  useEffect(() => {
    const tick = () =>
      setSeconds(Math.max(0, Math.ceil((step.startedAt + STEP_MS - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [step]);

  // Negative delay drops the animation in at the position the current step is
  // already at, so a page opened mid-step shows the truth immediately.
  const elapsed = Date.now() - step.startedAt;

  return (
    <div
      className="tfa-countdown"
      role="progressbar"
      aria-label={t('twoFactorCodeLife', { seconds })}
      aria-valuenow={seconds}
      aria-valuemin={0}
      aria-valuemax={TOTP_STEP_SECONDS}
    >
      <span className="tfa-countdown-track">
        <span
          key={step.counter}
          className="tfa-countdown-fill"
          style={{ animationDelay: `-${elapsed}ms` }}
        />
      </span>
      <span className="tfa-countdown-seconds">{t('twoFactorSecondsLeft', { seconds })}</span>
    </div>
  );
}
