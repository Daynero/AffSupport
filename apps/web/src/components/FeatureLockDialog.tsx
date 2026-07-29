import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { unlockFeature, type FeatureId } from '../lib/feature-flags';
import { Button } from './ui';

/**
 * The "still under construction" warning shown when a user tries to open a
 * protected, not-yet-acknowledged feature. Confirming records the
 * acknowledgment for this browser (persisted in localStorage) and calls
 * `onUnlocked`; declining just closes the dialog.
 */
export default function FeatureLockDialog({
  feature,
  onUnlocked,
  onClose
}: {
  feature: FeatureId;
  onUnlocked: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() =>
      dialog.current?.querySelector<HTMLElement>('.button-primary')?.focus()
    );
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const confirm = () => {
    unlockFeature(feature);
    onUnlocked();
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
        className="lock-modal"
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

        <header className="lock-head">
          <span className="lock-emoji" aria-hidden="true">
            🚧
          </span>
          <h2 id={titleId}>{t('featureLockTitle')}</h2>
          <p>{t('featureLockBody1')}</p>
          <p>{t('featureLockBody2')}</p>
          <p className="lock-note">{t('featureLockLocal')}</p>
        </header>

        <div className="lock-actions">
          <Button variant="primary" onClick={confirm}>
            {t('featureLockConfirm')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('featureLockCancel')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
