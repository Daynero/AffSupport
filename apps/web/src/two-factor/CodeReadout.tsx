/**
 * A live code, its remaining life, and whether it reached the clipboard.
 *
 * The same cluster appears in two places — inside a row that was asked for a
 * code, and inside the quick-code bar for a key that is not stored at all — so
 * it is one component rather than two that drift apart.
 *
 * The digits are grouped `483 921` because six digits are read and typed in two
 * threes, and the bar drains rather than counting up: the question a person has
 * is "do I still have time to paste this", not "how many seconds have passed".
 */

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { TOTP_STEP_SECONDS, generateTotp, totpStepEndsAt } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';

const STEP_MS = TOTP_STEP_SECONDS * 1000;

/** Transient: shown, put on the clipboard, and never stored. */
export interface LiveCode {
  digits: string;
  validUntil: number;
  /** Null while the clipboard write is still in flight. */
  copied: boolean | null;
}

/** Computes the code for `seed` now, ready to hand straight to the clipboard. */
export function makeCode(seed: string, atMs: number = Date.now()): LiveCode {
  return { digits: generateTotp(seed, atMs), validUntil: totpStepEndsAt(atMs), copied: null };
}

export function CodeReadout({ code, onExpired }: { code: LiveCode; onExpired: () => void }) {
  const { t } = useI18n();
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, code.validUntil - Date.now()));

  useEffect(() => {
    const tick = () => {
      const left = code.validUntil - Date.now();
      if (left <= 0) {
        setRemainingMs(0);
        onExpired();
        return;
      }
      setRemainingMs(left);
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [code, onExpired]);

  const seconds = Math.ceil(remainingMs / 1000);
  const grouped = `${code.digits.slice(0, 3)} ${code.digits.slice(3)}`;

  return (
    <div className="tfa-readout">
      <span className="tfa-readout-digits">{grouped}</span>
      <span
        className="tfa-readout-life"
        role="progressbar"
        aria-label={t('twoFactorCodeLife', { seconds })}
        aria-valuenow={seconds}
        aria-valuemin={0}
        aria-valuemax={TOTP_STEP_SECONDS}
      >
        <span style={{ width: `${Math.max(0, (remainingMs / STEP_MS) * 100)}%` }} />
      </span>
      <span className="tfa-readout-seconds">{t('twoFactorSecondsLeft', { seconds })}</span>
      {code.copied === true && (
        <span className="tfa-readout-copied">
          <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('twoFactorCopied')}
        </span>
      )}
      {code.copied === false && (
        <span className="tfa-readout-failed" role="alert">
          {t('twoFactorCopyFailed')}
        </span>
      )}
    </div>
  );
}
