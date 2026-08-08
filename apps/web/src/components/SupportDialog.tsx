import { useEffect, useId, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useI18n } from '../i18n';
import { analytics } from '../analytics/service';
import { activeCryptoWallets, hasDonationOptions, monobankUrl, supportEmail } from '../lib/support';
import { useSupportGoal } from '../support/SupportGoalContext';
import {
  formatSupportAmount,
  supportGoalDescription,
  supportGoalProgress,
  supportGoalTitle
} from '../support/goals';
import { Modal } from './Modal';
import { Button } from './ui';

/** Header trigger that opens the "Support the project" dialog. */
export function SupportButton() {
  const { language, t } = useI18n();
  const { goal } = useSupportGoal();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const progress = goal ? supportGoalProgress(goal) : null;
  const raised = goal ? formatSupportAmount(goal.raised_cents, goal.currency, language) : '';
  const target = goal ? formatSupportAmount(goal.target_cents, goal.currency, language) : '';
  const goalId = goal?.id;
  const goalSlug = goal?.slug;

  useEffect(() => {
    if (!goalId || !goalSlug) return;
    analytics.track('feature_impression', { feature_identifier: goalSlug });
  }, [goalId, goalSlug]);

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
        className={`support-trigger${goal ? ' has-goal' : ''}${progress?.complete ? ' is-complete' : ''}`}
        aria-haspopup="dialog"
        aria-label={goal ? t('supportGoalOpen', { raised, target }) : t('supportOpen')}
        onClick={openDialog}
      >
        <HeartIcon />
        <span className="support-trigger-label">
          {goal ? t('supportGoalShort') : t('supportProject')}
        </span>
        {goal && progress && (
          <>
            <strong className="support-trigger-amount" aria-hidden="true">
              {raised}
              <span>/</span>
              {target}
            </strong>
            <span className="support-trigger-progress" aria-hidden="true">
              <i style={{ width: `${progress.visualPercent}%` }} />
            </span>
          </>
        )}
      </button>
      {open && <SupportDialog onClose={close} />}
    </>
  );
}

function SupportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { goal } = useSupportGoal();
  const titleId = useId();
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

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

  return (
    <Modal size="lg" labelledBy={titleId} onClose={onClose} closeLabel={t('supportClose')}>
      <header className="support-head">
        <span className="support-badge" aria-hidden="true">
          <HeartIcon />
        </span>
        <h2 id={titleId}>{t('supportTitle')}</h2>
        <p>{t('supportIntro')}</p>
      </header>

      {goal && <SupportGoalCard />}

      <section className="support-section">
        <h3>{goal ? t('supportGoalDonateTitle') : t('supportDonateTitle')}</h3>
        {hasDonationOptions ? (
          <div className="support-donate">
            {monobankUrl && (
              <a
                className="button button-primary support-monobank"
                href={monobankUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() =>
                  analytics.track('support_donation_clicked', {
                    feature_identifier: goal?.slug ?? 'general-support',
                    action_identifier: 'monobank'
                  })
                }
              >
                {goal
                  ? `${t('supportGoalDonateCta')} · ${t('supportMonobank')}`
                  : `${t('supportMonobank')} · ${t('supportMonobankOpen')}`}
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
    </Modal>
  );
}

function SupportGoalCard() {
  const { language, t } = useI18n();
  const { goal } = useSupportGoal();
  if (!goal) return null;
  const progress = supportGoalProgress(goal);
  const raised = formatSupportAmount(goal.raised_cents, goal.currency, language);
  const target = formatSupportAmount(goal.target_cents, goal.currency, language);
  const remaining = formatSupportAmount(progress.remainingCents, goal.currency, language);
  const progressText = t('supportGoalRaisedOf', { raised, target });

  return (
    <section className={`support-goal-card${progress.complete ? ' is-complete' : ''}`}>
      <div className="support-goal-heading">
        <span>{t('supportGoalEyebrow')}</span>
        <strong>{t('supportGoalTarget', { amount: target })}</strong>
      </div>
      <h3>{supportGoalTitle(goal, language)}</h3>
      <p>{supportGoalDescription(goal, language)}</p>
      <div className="support-goal-funding">
        <div className="support-goal-total">
          <span>{t('supportGoalCollected')}</span>
          <strong>
            {raised}
            <small>/ {target}</small>
          </strong>
        </div>
        <div className="support-goal-percent">
          <strong>{progress.displayPercent}%</strong>
          <span>
            {progress.complete
              ? t('supportGoalComplete')
              : t('supportGoalRemaining', { amount: remaining })}
          </span>
        </div>
      </div>
      <div
        className="support-goal-progress"
        role="progressbar"
        aria-label={t('supportGoalProgressLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.displayPercent}
        aria-valuetext={progressText}
      >
        <span style={{ width: `${progress.visualPercent}%` }}>
          <i />
        </span>
      </div>
      <small className="support-goal-note">{t('supportGoalManualNote')}</small>
    </section>
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
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M10 17.5 8.9 16.5C4.7 12.8 2 10.4 2 7.4 2 4.9 4 3 6.5 3c1.4 0 2.7.7 3.5 1.8C10.8 3.7 12.1 3 13.5 3 16 3 18 4.9 18 7.4c0 3-2.7 5.4-6.9 9.1L10 17.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
