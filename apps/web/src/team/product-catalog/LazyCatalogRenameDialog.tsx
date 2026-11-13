import { lazy, Suspense, useEffect, useState } from 'react';
import { Modal } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';
import type { CatalogRenameDialogProps } from './CatalogRenameDialog.js';

const Dialog = lazy(() =>
  import('./CatalogRenameDialog.js').then(module => ({ default: module.CatalogRenameDialog }))
);

/** Load only on the first rename intent. Closing retains pending reconciliation. */
export function LazyCatalogRenameDialog(props: CatalogRenameDialogProps) {
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
          <Modal nested size="sm" title={t('launchCatalogRenameTitle')} onClose={props.onClose}>
            <p className="text-label text-muted" role="status">
              {t('launchCatalogRenameLoading')}
            </p>
          </Modal>
        ) : null
      }
    >
      <Dialog {...props} />
    </Suspense>
  );
}
