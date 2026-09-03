/**
 * The digits, and the press that copies them (feature 016).
 *
 * The code *is* the button. There was a labelled "Copy code" button beside a
 * blank space, which meant the most useful thing the tool knows was hidden
 * behind a click and the same fourteen characters were repeated down the whole
 * column. Now the digits are on screen and clicking them copies — one target
 * instead of two, and the association between what you see and what you get is
 * the element itself rather than a convention.
 */

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { generateTotp } from '@video-compressor/shared';
import { ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { copyText } from './clipboard';
import type { TotpStep } from './totp-clock';

/** Six digits read and typed in two threes. */
function grouped(digits: string): string {
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function CodeCell({
  seed,
  step,
  label,
  onCopyFailed
}: {
  seed: string;
  step: TotpStep;
  /** What this code belongs to, for the button's accessible name. */
  label: string;
  onCopyFailed: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  // Recomputed only when the page's step counter turns over, not on every tick.
  const digits = generateTotp(seed, step.startedAt + 1);

  useEffect(() => {
    setCopied(false);
  }, [digits]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    // Synchronous by construction: the digits are already here, so the write
    // happens on this turn and keeps the user activation a browser demands.
    void copyText(digits).then(ok => {
      if (ok) setCopied(true);
      else onCopyFailed();
    });
  };

  return (
    <button
      type="button"
      className={copied ? 'tfa-code is-copied' : 'tfa-code'}
      aria-label={t('twoFactorCopyCodeFor', { name: label })}
      onClick={copy}
    >
      {/* Before the digits, not after: the column is right-aligned, and a mark
          on the trailing edge would push every number a glyph off the edge the
          countdown above them lines up with. */}
      <span className="tfa-code-mark" aria-hidden="true">
        {copied ? (
          <Check size={16} strokeWidth={ICON_STROKE} />
        ) : (
          <Copy size={16} strokeWidth={ICON_STROKE} />
        )}
      </span>
      {/* Keyed on the digits, so React remounts the span when the step turns
          over and the fade replays. Six numbers silently becoming six other
          numbers is the one moment this page changes on its own. */}
      <span key={digits} className="tfa-code-digits">
        {grouped(digits)}
      </span>
    </button>
  );
}
