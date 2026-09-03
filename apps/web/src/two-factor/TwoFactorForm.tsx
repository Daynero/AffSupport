/**
 * One form for adding a key and for editing one (feature 016).
 *
 * The same two fields answer both questions, so there is one component rather
 * than two that drift apart. What differs is only what it starts with and what
 * it does on save.
 *
 * The seed is validated here, before anything is sent, because the person can
 * fix it here — and the message says which rule was broken rather than
 * "invalid", which tells them nothing about a 32-character string.
 */

import { useId, useState, type FormEvent } from 'react';
import { parseTwoFactorSeed, type TwoFactorSeedError } from '@video-compressor/shared';
import { Button } from '../components/ui';
import { useI18n } from '../i18n';
import type { TranslationKey } from '../i18n';
import type { TwoFactorErrorCode } from '../api/two-factor';

const SEED_ERROR_KEYS: Record<TwoFactorSeedError, TranslationKey> = {
  EMPTY: 'twoFactorSeedErrorEmpty',
  NOT_BASE32: 'twoFactorSeedErrorNotBase32',
  TOO_SHORT: 'twoFactorSeedErrorTooShort',
  URI_WITHOUT_SECRET: 'twoFactorSeedErrorUriWithoutSecret'
};

/**
 * A refusal from the database, said in the same voice as the local checks.
 *
 * `INVALID_SECRET` here means the two validators disagreed, which is worth
 * saying plainly rather than as "something went wrong".
 */
function apiErrorKey(code: TwoFactorErrorCode): TranslationKey {
  if (code === 'INVALID_SECRET') return 'twoFactorSeedErrorNotBase32';
  if (code === 'INVALID_NAME') return 'twoFactorNameRequired';
  return 'twoFactorSaveFailed';
}

export interface TwoFactorFormProps {
  initialName?: string;
  /** Present when editing: an unchanged field means "keep the stored key". */
  editing?: boolean;
  /** Resolves to an error code when the save was refused, or null when it stuck. */
  onSubmit: (name: string, seed: string | null) => Promise<TwoFactorErrorCode | null>;
  onCancel: () => void;
}

export function TwoFactorForm({
  initialName = '',
  editing = false,
  onSubmit,
  onCancel
}: TwoFactorFormProps) {
  const { t } = useI18n();
  // Explicit ids rather than a wrapping <label>: the accessibility tree in
  // Chrome left the wrapped inputs with no name at all, so a screen reader
  // announced two anonymous text fields.
  const nameId = useId();
  const seedId = useId();
  const [name, setName] = useState(initialName);
  const [seed, setSeed] = useState('');
  const [error, setError] = useState<TranslationKey | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * An enrolment link carries the account it belongs to. Filling an empty name
   * from it saves the one piece of typing a paste cannot avoid; a name already
   * written is never overwritten.
   */
  const takeSeed = (value: string) => {
    setSeed(value);
    setError(null);
    if (name.trim() !== '') return;
    const parsed = parseTwoFactorSeed(value);
    if (parsed.ok && parsed.label) setName(parsed.label);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (cleanName === '') {
      setError('twoFactorNameRequired');
      return;
    }

    // Editing with the key field left alone means "rename only" — the stored
    // key is not something the form can show, so it cannot be re-typed either.
    let value: string | null = null;
    if (!editing || seed.trim() !== '') {
      const parsed = parseTwoFactorSeed(seed);
      if (!parsed.ok) {
        setError(SEED_ERROR_KEYS[parsed.error]);
        return;
      }
      value = parsed.secret;
    }

    setSaving(true);
    const failure = await onSubmit(cleanName, value);
    setSaving(false);
    // The typed values stay on a refusal: retyping a 32-character key because
    // the name was too long would be its own small punishment.
    if (failure) setError(apiErrorKey(failure));
  };

  return (
    <form className="two-factor-form" onSubmit={submit}>
      <label htmlFor={nameId}>
        {t('twoFactorNameLabel')}
        <input
          id={nameId}
          type="text"
          value={name}
          maxLength={120}
          autoComplete="off"
          onChange={event => {
            setName(event.target.value);
            setError(null);
          }}
        />
      </label>
      <label htmlFor={seedId}>
        {t('twoFactorSeedLabel')}
        <input
          id={seedId}
          type="text"
          value={seed}
          autoComplete="off"
          spellCheck={false}
          placeholder={editing ? t('twoFactorSeedHint') : undefined}
          onChange={event => takeSeed(event.target.value)}
        />
      </label>
      <p className="two-factor-form-hint">{t('twoFactorSeedHint')}</p>
      {error && (
        <p className="two-factor-form-error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="two-factor-form-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('twoFactorCancel')}
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {t('twoFactorSave')}
        </Button>
      </div>
    </form>
  );
}
