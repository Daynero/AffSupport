/**
 * A code for a key that is not in the notebook (feature 016).
 *
 * Pinned above the list, because the case it answers is urgent and one-off:
 * somebody sends you a key, or you are half-way through enrolling an account,
 * and you need the six digits once without storing anything. Nothing typed here
 * is saved — it never reaches the database, and it is gone when the bar closes.
 *
 * The same synchronous rule as everywhere else: the key is parsed and the code
 * computed inside the click, so the clipboard write keeps the user activation a
 * browser demands.
 */

import { useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, X } from 'lucide-react';
import { parseTwoFactorSeed, type TwoFactorSeedError } from '@video-compressor/shared';
import { IconButton } from '../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n, type TranslationKey } from '../i18n';
import { copyText } from './clipboard';
import { CodeReadout, makeCode, type LiveCode } from './CodeReadout';

const SEED_ERROR_KEYS: Record<TwoFactorSeedError, TranslationKey> = {
  EMPTY: 'twoFactorSeedErrorEmpty',
  NOT_BASE32: 'twoFactorSeedErrorNotBase32',
  TOO_SHORT: 'twoFactorSeedErrorTooShort',
  URI_WITHOUT_SECRET: 'twoFactorSeedErrorUriWithoutSecret'
};

export function QuickCode({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [code, setCode] = useState<LiveCode | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const run = () => {
    const parsed = parseTwoFactorSeed(value);
    if (!parsed.ok) {
      setCode(null);
      setError(SEED_ERROR_KEYS[parsed.error]);
      return;
    }
    setError(null);
    const made = makeCode(parsed.secret);
    setCode(made);
    void copyText(made.digits).then(ok =>
      setCode(current =>
        current && current.digits === made.digits ? { ...current, copied: ok } : current
      )
    );
  };

  return (
    <section className="tfa-quick" aria-label={t('twoFactorQuickCode')}>
      <div className="tfa-quick-field">
        <KeyRound size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <input
          ref={field}
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('twoFactorQuickPlaceholder')}
          placeholder={t('twoFactorQuickPlaceholder')}
          onChange={event => {
            setValue(event.target.value);
            setError(null);
            setCode(null);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              run();
            }
          }}
        />
      </div>

      <button type="button" className="tfa-copy-code tfa-quick-run" onClick={run}>
        <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {t('twoFactorCopyCode')}
      </button>

      {code && <CodeReadout code={code} onExpired={() => setCode(null)} />}
      {error && (
        <span className="tfa-quick-error" role="alert">
          {t(error)}
        </span>
      )}

      <IconButton label={t('twoFactorQuickClose')} className="tfa-quick-close" onClick={onClose}>
        <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
    </section>
  );
}
