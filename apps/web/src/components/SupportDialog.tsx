import { lazy, Suspense, useId, useState } from 'react';
import { useI18n } from '../i18n';
import { analytics } from '../analytics/service';
import { supportEmail } from '../lib/support';
import { Modal } from './Modal';
import { Button, FormField, Textarea } from './ui/index';

/**
 * Loaded on demand. The bundle reads the local app's journal, so it needs the agent client
 * and context; the support dialog is mounted on every page, including ones that never
 * talk to the local app, and must not pull that graph in with it.
 */
const DiagnosticsBundle = lazy(() =>
  import('../support/DiagnosticsBundle').then(module => ({ default: module.DiagnosticsBundle }))
);

/**
 * Technical support: a message to the support inbox and the diagnostics bundle. The
 * donation side of this dialog (goal, Monobank jar, crypto wallets) was removed on the
 * owner's word; nothing in the product opened it any more.
 */
export function SupportDialog({
  onClose,
  returnFocus
}: {
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const messageId = useId();
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

  const send = () => {
    if (!message.trim()) {
      setError(true);
      return;
    }
    const href = `mailto:${supportEmail}?subject=${encodeURIComponent(
      t('technicalSupportSubject')
    )}&body=${encodeURIComponent(message.trim())}`;
    analytics.track('support_feedback_started', {});
    window.location.href = href;
    onClose();
  };

  return (
    <Modal
      size="lg"
      labelledBy={titleId}
      onClose={onClose}
      closeLabel={t('supportClose')}
      returnFocus={returnFocus}
      initialFocus="textarea"
    >
      <header className="support-head">
        <span className="support-badge" aria-hidden="true">
          <TechnicalSupportIcon />
        </span>
        <h2 id={titleId}>{t('technicalSupportTitle')}</h2>
        <p>{t('technicalSupportIntro')}</p>
      </header>

      <section className="support-section">
        <h3>{t('technicalSupportMessageTitle')}</h3>
        <p className="support-note">{t('technicalSupportMessageHint')}</p>
        {supportEmail ? (
          <div className="support-form">
            <FormField
              label={t('supportMessageLabel')}
              htmlFor={messageId}
              error={error ? t('supportMessageRequired') : undefined}
            >
              <Textarea
                id={messageId}
                value={message}
                rows={4}
                invalid={error}
                placeholder={t('technicalSupportMessagePlaceholder')}
                onChange={event => {
                  setMessage(event.target.value);
                  if (error) setError(false);
                }}
              />
            </FormField>
            <Button color="primary" variant="solid" onClick={send}>
              {t('supportSend')}
            </Button>
          </div>
        ) : (
          <p className="support-note">{t('supportFeedbackSoon')}</p>
        )}
      </section>

      <Suspense fallback={null}>
        <DiagnosticsBundle />
      </Suspense>
    </Modal>
  );
}

function TechnicalSupportIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M5 13v-1a7 7 0 0 1 14 0v1M5 13H3v4h4v-4H5Zm14 0h2v4h-4v-4h2Zm-2 4c0 2.2-1.8 4-4 4h-2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}
