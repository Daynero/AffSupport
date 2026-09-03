/**
 * One account in the table, in whichever of its three states it is in.
 *
 * Reading it: a name and the actions. Asked for a code: the digits, their
 * draining life and whether they reached the clipboard, in place of the button
 * that produced them. Being corrected: two fields and a confirm/cancel pair,
 * edited where the row already is rather than in a form somewhere else — adding
 * a key uses the same row, so there is one editor and not two that drift.
 *
 * The key itself is never a column. Copying it and showing it live in the
 * overflow menu, because a list of keys on screen is a list anyone behind you
 * can photograph, and neither action is the one anybody needs every day.
 */

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Check, Copy, Eye, EyeOff, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import { parseTwoFactorSeed, type TwoFactorSeedError } from '@video-compressor/shared';
import { Modal } from '../components/Modal';
import { Button, IconButton } from '../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useToasts } from '../components/toast';
import { useI18n, type TranslationKey } from '../i18n';
import type { TwoFactorEntry, TwoFactorErrorCode } from '../api/two-factor';
import { copyText } from './clipboard';
import { CodeReadout, makeCode, type LiveCode } from './CodeReadout';

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
  selected,
  onSelectedChange,
  onEdit,
  onDelete
}: {
  entry: TwoFactorEntry;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onEdit: () => void;
  onDelete: () => Promise<TwoFactorErrorCode | null>;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const titleId = useId();
  const [code, setCode] = useState<LiveCode | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  const copyCode = () => {
    // Arithmetic only, on this turn: no await stands between the click and the
    // clipboard write, which is the whole reason the TOTP module is synchronous.
    const made = makeCode(entry.seed);
    setCode(made);
    void copyText(made.digits).then(ok =>
      setCode(current =>
        current && current.digits === made.digits ? { ...current, copied: ok } : current
      )
    );
  };

  const copySeed = () => {
    setMenuOpen(false);
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

      <td className="tfa-cell-live">
        {code && <CodeReadout code={code} onExpired={() => setCode(null)} />}
        {!code && revealed && <span className="tfa-seed">{entry.seed}</span>}
      </td>

      <td className="tfa-cell-actions">
        <div className="tfa-actions">
          {!code && (
            <button type="button" className="tfa-copy-code" onClick={copyCode}>
              <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('twoFactorCopyCode')}
            </button>
          )}
          <IconButton label={t('twoFactorEdit')} onClick={onEdit}>
            <Pencil size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <div className="tfa-menu-anchor">
            <IconButton
              label={t('twoFactorRowMenu')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(open => !open)}
            >
              <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
            {menuOpen && (
              <RowMenu
                revealed={revealed}
                onCopySeed={copySeed}
                onToggleReveal={() => {
                  setRevealed(current => !current);
                  setMenuOpen(false);
                }}
                onDelete={() => {
                  setMenuOpen(false);
                  setConfirming(true);
                }}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </div>
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

function RowMenu({
  revealed,
  onCopySeed,
  onToggleReveal,
  onDelete,
  onClose
}: {
  revealed: boolean;
  onCopySeed: () => void;
  onToggleReveal: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose]);

  return (
    <div className="tfa-menu" role="menu" ref={menu}>
      <button type="button" role="menuitem" onClick={onCopySeed}>
        <Copy size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {t('twoFactorCopyKey')}
      </button>
      <button type="button" role="menuitem" onClick={onToggleReveal}>
        {revealed ? (
          <EyeOff size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        ) : (
          <Eye size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        )}
        {revealed ? t('twoFactorHide') : t('twoFactorReveal')}
      </button>
      <button type="button" role="menuitem" className="tfa-menu-danger" onClick={onDelete}>
        <Trash2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {t('twoFactorDelete')}
      </button>
    </div>
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
      </td>
      <td className="tfa-cell-live">
        <ClearableField
          value={seed}
          label={requireSeed ? t('twoFactorKeyPlaceholder') : t('twoFactorKeyPlaceholderKeep')}
          onChange={takeSeed}
          onKeyDown={onKeyDown}
        />
      </td>
      <td className="tfa-cell-actions">
        <div className="tfa-actions">
          {error && (
            <span className="tfa-edit-error" role="alert">
              {t(error)}
            </span>
          )}
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
