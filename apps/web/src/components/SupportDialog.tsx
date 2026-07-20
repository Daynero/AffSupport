import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { useI18n } from '../i18n';
import { analytics } from '../analytics/service';
import { activeCryptoWallets, hasDonationOptions, monobankUrl, supportEmail } from '../lib/support';
import { Button } from './ui';

/** Header trigger that opens the "Support the project" dialog. */
export function SupportButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const openDialog = () => {
    setOpen(true);
    analytics.track('support_opened', {});
  };

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="support-trigger"
        aria-haspopup="dialog"
        aria-label={t('supportOpen')}
        onClick={openDialog}
      >
        <HeartIcon />
        <span>{t('supportProject')}</span>
      </button>
      {open && <SupportDialog onClose={close} />}
    </>
  );
}

function SupportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() =>
      dialog.current?.querySelector<HTMLElement>('textarea, a, button')?.focus()
    );
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const send = () => {
    if (!message.trim()) {
      setError(true);
      return;
    }
    const href = `mailto:${supportEmail}?subject=${encodeURIComponent(
      t('supportSubject')
    )}&body=${encodeURIComponent(message.trim())}`;
    analytics.track('support_feedback_started', {});
    window.location.href = href;
    onClose();
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="support-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button
          type="button"
          className="support-close"
          aria-label={t('supportClose')}
          onClick={onClose}
        >
          ✕
        </button>

        <header className="support-head">
          <span className="support-badge" aria-hidden="true">
            <HeartIcon />
          </span>
          <h2 id={titleId}>{t('supportTitle')}</h2>
          <p>{t('supportIntro')}</p>
        </header>

        <section className="support-section">
          <h3>{t('supportDonateTitle')}</h3>
          {hasDonationOptions ? (
            <div className="support-donate">
              {monobankUrl && (
                <a
                  className="button button-primary support-monobank"
                  href={monobankUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('supportMonobank')} · {t('supportMonobankOpen')}
                </a>
              )}
              {activeCryptoWallets.length > 0 && (
                <div className="support-crypto">
                  <p className="support-note">{t('supportCryptoNote')}</p>
                  {activeCryptoWallets.map(wallet => (
                    <CryptoRow
                      key={wallet.network}
                      network={wallet.network}
                      address={wallet.address}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="support-note">{t('supportDonateSoon')}</p>
          )}
        </section>

        <section className="support-section">
          <h3>{t('supportFeedbackTitle')}</h3>
          <p className="support-note">{t('supportFeedbackHint')}</p>
          {supportEmail ? (
            <div className="support-form">
              <label className="support-field">
                <span>{t('supportMessageLabel')}</span>
                <textarea
                  value={message}
                  rows={4}
                  placeholder={t('supportMessagePlaceholder')}
                  onChange={event => {
                    setMessage(event.target.value);
                    if (error) setError(false);
                  }}
                />
              </label>
              {error && <span className="support-error">{t('supportMessageRequired')}</span>}
              <Button variant="primary" onClick={send}>
                {t('supportSend')}
              </Button>
            </div>
          ) : (
            <p className="support-note">{t('supportFeedbackSoon')}</p>
          )}
        </section>
      </div>
    </div>,
    document.body
  );
}

function CryptoRow({ network, address }: { network: string; address: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(address, { margin: 1, width: 320, errorCorrectionLevel: 'M' })
      .then(url => {
        if (active) setQr(url);
      })
      .catch(() => {
        /* QR generation failed — address text and copy button still work. */
      });
    return () => {
      active = false;
    };
  }, [address]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      /* Clipboard unavailable — the address stays visible for manual copy. */
    }
  };

  return (
    <div className="support-wallet">
      <div className="support-wallet-row">
        <div className="support-wallet-info">
          <strong>{network}</strong>
          <code>{address}</code>
        </div>
        <button type="button" className="support-copy" onClick={() => void copy()}>
          {copied ? t('supportCopied') : t('supportCopy')}
        </button>
      </div>
      {qr && (
        <figure className="support-qr">
          <img src={qr} alt={t('supportQrAlt', { network })} width={120} height={120} />
          <figcaption>{t('supportScan')}</figcaption>
        </figure>
      )}
    </div>
  );
}

function HeartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M10 17s-6.2-3.9-8.2-7.6C.4 6.7 1.8 4 4.6 4c1.8 0 3 1 4.4 2.6C10.4 5 11.6 4 13.4 4c2.8 0 4.2 2.7 2.8 5.4C16.2 13.1 10 17 10 17Z"
        fill="currentColor"
      />
    </svg>
  );
}
