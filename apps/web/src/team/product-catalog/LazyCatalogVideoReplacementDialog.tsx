import { lazy, Suspense, useEffect, useState } from 'react';
import { Modal, LoadingState } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import type { CatalogVideoReplacementDialogProps } from './CatalogVideoReplacementDialog';
const Dialog = lazy(() =>
  import('./CatalogVideoReplacementDialog').then(m => ({
    default: m.CatalogVideoReplacementDialog
  }))
);
export function LazyCatalogVideoReplacementDialog(props: CatalogVideoReplacementDialogProps) {
  const { t } = useI18n();
  const [activated, setActivated] = useState(props.open);
  useEffect(() => {
    if (props.open) setActivated(true);
  }, [props.open]);
  if (!activated && !props.open) return null;
  return (
    <Suspense
      fallback={
        props.open ? (
          <Modal nested title={t('catalogReplaceVideoTitle')} onClose={props.onClose}>
            <LoadingState count={1} label={t('catalogSettingsLoading')} />
          </Modal>
        ) : null
      }
    >
      <Dialog {...props} />
    </Suspense>
  );
}
