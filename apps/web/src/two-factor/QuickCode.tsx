/**
 * A code for a key that is not in the wallet (feature 016).
 *
 * Always above the table, because the case it answers arrives without warning:
 * somebody sends you a key, or you are half-way through enrolling an account,
 * and you need the six digits once without storing anything. Nothing typed here
 * is saved — it never reaches the database, and it is gone on the next reload.
 *
 * It carries a heading of its own, because without one it was a wide input with
 * a placeholder sitting directly under a wide input with a placeholder, and
 * people would type account searches into it.
 *
 * The code appears the moment the key parses; there is nothing to press first.
 * It rides the page's own step counter, so a key pasted at second 29 shows the
 * next code a moment later rather than an expired one.
 */

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { parseTwoFactorSeed, type TwoFactorSeedError } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useToasts } from '../components/toast';
import { useI18n, type TranslationKey } from '../i18n';
import { CodeCell } from './CodeCell';
import type { TotpStep } from './totp-clock';

const SEED_ERROR_KEYS: Record<TwoFactorSeedError, TranslationKey> = {
  EMPTY: 'twoFactorSeedErrorEmpty',
  NOT_BASE32: 'twoFactorSeedErrorNotBase32',
  TOO_SHORT: 'twoFactorSeedErrorTooShort',
  URI_WITHOUT_SECRET: 'twoFactorSeedErrorUriWithoutSecret'
};

export function QuickCode({ step }: { step: TotpStep }) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [value, setValue] = useState('');

  const trimmed = value.trim();
  const parsed = trimmed === '' ? null : parseTwoFactorSeed(trimmed);

  return (
    <section className="tfa-quick" aria-label={t('twoFactorQuickCode')}>
      <p className="tfa-quick-heading">{t('twoFactorQuickCode')}</p>
      <div className="tfa-quick-row">
        <div className="tfa-quick-field">
          <KeyRound size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <input
            type="text"
            value={value}
            spellCheck={false}
            autoComplete="off"
            aria-label={t('twoFactorQuickPlaceholder')}
            placeholder={t('twoFactorQuickPlaceholder')}
            onChange={event => setValue(event.target.value)}
          />
        </div>

        {parsed?.ok && (
          <CodeCell
            seed={parsed.secret}
            step={step}
            label={t('twoFactorQuickCode')}
            onCopyFailed={() => push({ tone: 'error', text: t('twoFactorCopyFailed') })}
          />
        )}
        {/* Only once there is enough typed to be wrong about: complaining at the
            first character would be shouting at somebody mid-paste. */}
        {parsed && !parsed.ok && trimmed.length > 3 && (
          <span className="tfa-quick-error" role="alert">
            {t(SEED_ERROR_KEYS[parsed.error])}
          </span>
        )}
      </div>
    </section>
  );
}
