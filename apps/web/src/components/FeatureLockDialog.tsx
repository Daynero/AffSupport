import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { unlockFeature, type FeatureId } from '../lib/feature-flags';
import { Button } from './ui';

/**
 * The "still under construction" gate shown when a user tries to open a
 * protected, not-yet-unlocked feature. Entering the developer pass unlocks the
 * feature for this browser (persisted in localStorage) and calls `onUnlocked`.
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
  const [pass, setPass] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('input')?.focus());
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = () => {
    if (unlockFeature(feature, pass)) {
      onUnlocked();
      return;
    }
    setError(true);
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
          <p className="lock-soon">{t('featureLockSoon')}</p>
        </header>

        <form
          className="lock-form"
          onSubmit={event => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="support-field">
            <span>{t('featureLockPassLabel')}</span>
            <input
              type="password"
              value={pass}
              autoComplete="off"
              placeholder={t('featureLockPassPlaceholder')}
              onChange={event => {
                setPass(event.target.value);
                if (error) setError(false);
              }}
            />
          </label>
          {error && <span className="support-error">{t('featureLockError')}</span>}
          <Button type="submit" variant="primary">
            {t('featureLockUnlock')}
          </Button>
        </form>
      </div>
    </div>,
    document.body
  );
}
