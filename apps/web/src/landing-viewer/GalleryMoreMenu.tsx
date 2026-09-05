import type { ReactNode } from 'react';
import { Ellipsis, Eraser, Trash2 } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { MenuItem, MenuSeparator, ViewerMenu } from './internal/ViewerMenu';
import type { LandingViewerSourceCapabilities } from './types';

/**
 * Everything that is rare or destructive, plus whatever the toolbar had to put away when
 * the window got narrow (`leading`). Each entry renders only when the source can do it.
 */
export function GalleryMoreMenu({
  running,
  hasActiveCatalog,
  capabilities,
  leading,
  onClearCache,
  onRemoveActiveCatalog
}: {
  running: boolean;
  hasActiveCatalog: boolean;
  capabilities: LandingViewerSourceCapabilities;
  leading?: (close: () => void) => ReactNode;
  onClearCache: () => void;
  onRemoveActiveCatalog: () => void;
}) {
  const { t } = useI18n();
  const destructive = capabilities.clearCache || capabilities.removeCatalog;
  if (!destructive && !leading) return null;
  return (
    <ViewerMenu
      label={t('landingGalleryMoreActions')}
      trigger={<Ellipsis size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
    >
      {close => (
        <>
          {leading?.(close)}
          {leading && destructive && <MenuSeparator />}
          {capabilities.clearCache && (
            <MenuItem
              icon={<Eraser size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />}
              disabled={running}
              onClick={() => {
                close();
                onClearCache();
              }}
            >
              {t('landingGalleryClearCache')}
            </MenuItem>
          )}
          {capabilities.removeCatalog && (
            <MenuItem
              className="is-danger"
              icon={<Trash2 size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />}
              disabled={running || !hasActiveCatalog}
              onClick={() => {
                close();
                onRemoveActiveCatalog();
              }}
            >
              {t('landingGalleryRemoveActiveCatalog')}
            </MenuItem>
          )}
        </>
      )}
    </ViewerMenu>
  );
}
