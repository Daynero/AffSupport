/**
 * One stored key, on one line (feature 016).
 *
 * What the row shows in the key's place is a marker, not the key. The copy
 * button never needed it visible, and a list of seeds on screen is a list
 * anyone standing behind you can photograph. Revealing is a separate, per-row
 * press, and it does not persist: leaving the page covers everything again.
 *
 * The middle cell shows, in this order: the code you just asked for, then the
 * key if you asked to see it, then the marker. The code wins because it is the
 * thing with a deadline.
 */

import { useEffect, useId, useState } from 'react';
import { Copy, Eye, EyeOff, KeyRound, Pencil, Trash2 } from 'lucide-react';
import { TOTP_STEP_SECONDS, generateTotp, totpStepEndsAt } from '@video-compressor/shared';
import { Modal } from '../components/Modal';
import { Button, IconButton } from '../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useToasts } from '../components/toast';
import { useI18n } from '../i18n';
import type { TwoFactorEntry } from '../api/two-factor';
import { copyText } from './clipboard';
import { useTwoFactor } from './TwoFactorContext';

const STEP_MS = TOTP_STEP_SECONDS * 1000;

/** Transient: shown on the row, put on the clipboard, and never stored. */
interface GeneratedCode {
  digits: string;
  validUntil: number;
}

export function TwoFactorRow({
  entry,
  onEdit
}: {
  entry: TwoFactorEntry;
  onEdit: (entry: TwoFactorEntry) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { remove } = useTwoFactor();
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [code, setCode] = useState<GeneratedCode | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);

  /**
   * A code outlives its step by no time at all. Once the window passes the row
   * drops it rather than leaving it on screen: a stale code presented as current
   * is worse than none, because it gets pasted, rejected, and blamed on the key.
   */
  useEffect(() => {
    if (!code) return;
    const tick = () => {
      const left = code.validUntil - Date.now();
      if (left <= 0) {
        setCode(null);
        setRemainingMs(0);
        return;
      }
      setRemainingMs(left);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [code]);

  const reportCopy = (ok: boolean, fallbackToReveal: boolean) => {
    if (ok) {
      push({ tone: 'success', text: t('twoFactorCopied') });
      return;
    }
    // A failed copy must not look like a success. Showing the value is the
    // fallback that still lets the person get it: select it by hand.
    if (fallbackToReveal) setRevealed(true);
    push({ tone: 'error', text: t('twoFactorCopyFailed') });
  };

  const copySeed = () => {
    // Synchronous by construction: the key is already here, so the write
    // happens on this turn and keeps the user activation a browser demands.
    void copyText(entry.seed).then(ok => reportCopy(ok, true));
  };

  const generateAndCopy = () => {
    // Everything here is arithmetic, not I/O — no await stands between the
    // click and the clipboard write, which is the whole reason the TOTP
    // implementation is synchronous (research D2/D3).
    const now = Date.now();
    const digits = generateTotp(entry.seed, now);
    setCode({ digits, validUntil: totpStepEndsAt(now) });
    void copyText(digits).then(ok => reportCopy(ok, false));
  };

  const confirmRemoval = async () => {
    setRemoving(true);
    const failure = await remove(entry.id);
    setRemoving(false);
    setConfirming(false);
    if (failure) push({ tone: 'error', text: t('twoFactorDeleteFailed') });
  };

  const secondsLeft = Math.ceil(remainingMs / 1000);

  return (
    <li className="two-factor-row">
      <span className="two-factor-name" title={entry.name}>
        {entry.name}
      </span>
      {code ? (
        <span className="two-factor-code" title={t('twoFactorCodeLife', { seconds: secondsLeft })}>
          {code.digits}
          <span
            className="two-factor-code-life"
            role="progressbar"
            aria-label={t('twoFactorCodeLife', { seconds: secondsLeft })}
            aria-valuenow={secondsLeft}
            aria-valuemin={0}
            aria-valuemax={TOTP_STEP_SECONDS}
          >
            <span style={{ width: `${Math.max(0, (remainingMs / STEP_MS) * 100)}%` }} />
          </span>
        </span>
      ) : revealed ? (
        <span className="two-factor-seed">{entry.seed}</span>
      ) : (
        <span className="two-factor-marker">2fa</span>
      )}
      <div className="two-factor-actions">
        <IconButton label={t('twoFactorGenerate')} onClick={generateAndCopy}>
          <KeyRound size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        <IconButton label={t('twoFactorCopyKey')} onClick={copySeed}>
          <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={revealed ? t('twoFactorHide') : t('twoFactorReveal')}
          onClick={() => setRevealed(current => !current)}
        >
          {revealed ? (
            <EyeOff size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          ) : (
            <Eye size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          )}
        </IconButton>
        <IconButton label={t('twoFactorEdit')} onClick={() => onEdit(entry)}>
          <Pencil size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        <IconButton label={t('twoFactorDelete')} onClick={() => setConfirming(true)}>
          <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      </div>

      {confirming && (
        <Modal labelledBy={titleId} onClose={() => setConfirming(false)} size="sm">
          <h3 id={titleId}>{t('twoFactorDeleteTitle')}</h3>
          {/* Said plainly, because it is true and because there is no undo to
              fall back on: the vault secret goes with the row. */}
          <p>{t('twoFactorDeleteBody', { name: entry.name })}</p>
          <div className="two-factor-form-actions">
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              {t('twoFactorCancel')}
            </Button>
            <Button type="button" variant="danger" loading={removing} onClick={confirmRemoval}>
              {t('twoFactorDeleteConfirm')}
            </Button>
          </div>
        </Modal>
      )}
    </li>
  );
}
