/**
 * One account in the table, in whichever of its two states it is in.
 *
 * Reading it: a name and its live code, which is also the button that copies
 * it. Being corrected: two fields and a confirm/cancel pair, edited where the
 * row already is — adding an account uses the same row, so there is one editor
 * and not two that drift apart.
 *
 * The actions sit in the row rather than behind an overflow button, and they are
 * quiet rather than absent: borderless and muted at rest, full contrast when the
 * pointer is on the row. Hiding them cost a click on everything that is not
 * copying a code, and a "…" tells a newcomer nothing about what is inside it.
 *
 * The key, when shown, appears beside the code and copies the same way the code
 * does. Both of a row's copyable values then live in one place under one
 * gesture, instead of the key hanging under the name where nothing acts on it.
 */

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Check, Eye, EyeOff, KeyRound, Pencil, Trash2, X } from 'lucide-react';
import { parseTwoFactorSeed, type TwoFactorSeedError } from '@video-compressor/shared';
import { Modal } from '../components/Modal';
import { Button, IconButton } from '../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useToasts } from '../components/toast';
import { useI18n, type TranslationKey } from '../i18n';
import type { TwoFactorEntry, TwoFactorErrorCode } from '../api/two-factor';
import { copyText } from './clipboard';
import { CodeCell } from './CodeCell';
import type { TotpStep } from './totp-clock';

const SEED_ERROR_KEYS: Record<TwoFactorSeedError, TranslationKey> = {
  EMPTY: 'twoFactorSeedErrorEmpty',
  NOT_BASE32: 'twoFactorSeedErrorNotBase32',
  TOO_SHORT: 'twoFactorSeedErrorTooShort',
  URI_WITHOUT_SECRET: 'twoFactorSeedErrorUriWithoutSecret'
};

function apiErrorKey(code: TwoFactorErrorCode): TranslationKey {
  if (code === 'INVALID_SECRET') return 'twoFactorSeedErrorNotBase32';
  if (code === 'INVALID_NAME') return 'twoFactorNameRequired';
  return 'twoFactorSaveFailed';
}

// ---------------------------------------------------------------------------
// Reading a row
// ---------------------------------------------------------------------------

export function TwoFactorRow({
  entry,
  step,
  selected,
  onSelectedChange,
  onEdit,
  onDelete
}: {
  entry: TwoFactorEntry;
  step: TotpStep;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onEdit: () => void;
  onDelete: () => Promise<TwoFactorErrorCode | null>;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const titleId = useId();
  const [revealed, setRevealed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  const copySeed = () => {
    void copyText(entry.seed).then(ok => {
      if (ok) {
        push({ tone: 'success', text: t('twoFactorCopied') });
        return;
      }
      // A failed copy must never look like a success: show the value instead so
      // it can still be selected by hand.
      setRevealed(true);
      push({ tone: 'error', text: t('twoFactorCopyFailed') });
    });
  };

  const confirmRemoval = async () => {
    setRemoving(true);
    const failure = await onDelete();
    setRemoving(false);
    setConfirming(false);
    if (failure) push({ tone: 'error', text: t('twoFactorDeleteFailed') });
  };

  return (
    <tr className={selected ? 'tfa-row is-selected' : 'tfa-row'}>
      <td className="tfa-cell-check">
        <input
          type="checkbox"
          className="tfa-check"
          checked={selected}
          aria-label={t('twoFactorSelectRow', { name: entry.name })}
          onChange={event => onSelectedChange(event.target.checked)}
        />
      </td>

      <td className="tfa-cell-name">
        <span className="tfa-name" title={entry.name}>
          {entry.name}
        </span>
      </td>

      <td className="tfa-cell-code">
        {/* The flex lives on this wrapper, never on the cell: a `td` set to
            `display: flex` leaves the table layout, which cost the edit row's
            key field most of its width and broke the selected row's outline. */}
        <div className="tfa-code-cell">
          {revealed && (
            <button
              type="button"
              className="tfa-seed"
              aria-label={t('twoFactorCopyKey')}
              onClick={copySeed}
            >
              {entry.seed}
            </button>
          )}
          <CodeCell
            seed={entry.seed}
            step={step}
            label={entry.name}
            onCopyFailed={() => push({ tone: 'error', text: t('twoFactorCopyFailed') })}
          />
        </div>
      </td>

      <td className="tfa-cell-actions">
        <div className="tfa-actions">
          {/* Copying the key without putting it on screen stays its own action:
              handing a key to a colleague mid-screen-share should not flash it
              at the call. */}
          <IconButton label={t('twoFactorCopyKey')} onClick={copySeed}>
            <KeyRound size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <IconButton
            label={revealed ? t('twoFactorHide') : t('twoFactorReveal')}
            aria-pressed={revealed}
            onClick={() => setRevealed(current => !current)}
          >
            {revealed ? (
              <EyeOff size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
            ) : (
              <Eye size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
            )}
          </IconButton>
          <IconButton label={t('twoFactorEdit')} onClick={onEdit}>
            <Pencil size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <IconButton
            label={t('twoFactorDelete')}
            className="tfa-danger"
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </div>

        {confirming && (
          <Modal labelledBy={titleId} onClose={() => setConfirming(false)} size="sm">
            <h3 id={titleId}>{t('twoFactorDeleteTitle')}</h3>
            {/* Said plainly, because it is true and there is no undo: the vault
                secret goes with the row. */}
            <p>{t('twoFactorDeleteBody', { name: entry.name })}</p>
            <div className="tfa-modal-actions">
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                {t('twoFactorCancel')}
              </Button>
              <Button type="button" variant="danger" loading={removing} onClick={confirmRemoval}>
                {t('twoFactorDeleteConfirm')}
              </Button>
            </div>
          </Modal>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Correcting a row, and adding one
// ---------------------------------------------------------------------------

export function TwoFactorEditRow({
  initialName = '',
  /** A new row must be given a key; an existing one may be renamed alone. */
  requireSeed,
  onSave,
  onCancel
}: {
  initialName?: string;
  requireSeed: boolean;
  onSave: (name: string, seed: string | null) => Promise<TwoFactorErrorCode | null>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const [seed, setSeed] = useState('');
  const [error, setError] = useState<TranslationKey | null>(null);
  const [saving, setSaving] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameField.current?.focus();
  }, []);

  /**
   * An enrolment link carries the account it belongs to, so an empty name is
   * filled from it — the one piece of typing a paste cannot avoid. A name
   * already written is never overwritten.
   */
  const takeSeed = (value: string) => {
    setSeed(value);
    setError(null);
    if (name.trim() !== '') return;
    const parsed = parseTwoFactorSeed(value);
    if (parsed.ok && parsed.label) setName(parsed.label);
  };

  const submit = async () => {
    const cleanName = name.trim();
    if (cleanName === '') {
      setError('twoFactorNameRequired');
      return;
    }

    let value: string | null = null;
    if (requireSeed || seed.trim() !== '') {
      const parsed = parseTwoFactorSeed(seed);
      if (!parsed.ok) {
        setError(SEED_ERROR_KEYS[parsed.error]);
        return;
      }
      value = parsed.secret;
    }

    setSaving(true);
    const failure = await onSave(cleanName, value);
    setSaving(false);
    // Typed values survive a refusal: retyping a 32-character key because the
    // name was too long would be its own small punishment.
    if (failure) setError(apiErrorKey(failure));
  };

  const onKeyDown = (event: { key: string; preventDefault: () => void }) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <tr className="tfa-row is-editing">
      <td className="tfa-cell-check" />
      <td className="tfa-cell-name">
        <ClearableField
          inputRef={nameField}
          value={name}
          label={t('twoFactorNamePlaceholder')}
          onChange={next => {
            setName(next);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          focused
        />
        {error === 'twoFactorNameRequired' && (
          <span className="tfa-edit-error" role="alert">
            {t(error)}
          </span>
        )}
      </td>
      <td className="tfa-cell-code">
        <ClearableField
          value={seed}
          label={requireSeed ? t('twoFactorKeyPlaceholder') : t('twoFactorKeyPlaceholderKeep')}
          onChange={takeSeed}
          onKeyDown={onKeyDown}
        />
        {error !== null && error !== 'twoFactorNameRequired' && (
          <span className="tfa-edit-error" role="alert">
            {t(error)}
          </span>
        )}
      </td>
      <td className="tfa-cell-actions">
        <div className="tfa-actions">
          <IconButton
            label={t('twoFactorSave')}
            className="tfa-confirm"
            disabled={saving}
            onClick={() => void submit()}
          >
            <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <IconButton label={t('twoFactorCancel')} className="tfa-reject" onClick={onCancel}>
            <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </div>
      </td>
    </tr>
  );
}

function ClearableField({
  value,
  label,
  onChange,
  onKeyDown,
  inputRef,
  focused = false
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
  onKeyDown: (event: { key: string; preventDefault: () => void }) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  focused?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={focused ? 'tfa-field is-focus' : 'tfa-field'}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        placeholder={label}
        onChange={event => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {value !== '' && (
        <IconButton label={t('twoFactorClearField')} onClick={() => onChange('')}>
          <X size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
