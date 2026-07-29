import { useId } from 'react';
import { useI18n } from '../i18n';
import { unlockFeature, type FeatureId } from '../lib/feature-flags';
import { Modal } from './Modal';
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

  const confirm = () => {
    unlockFeature(feature);
    onUnlocked();
  };

  return (
    <Modal
      size="sm"
      labelledBy={titleId}
      onClose={onClose}
      closeLabel={t('supportClose')}
      initialFocus=".button-primary"
    >
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
    </Modal>
  );
}
