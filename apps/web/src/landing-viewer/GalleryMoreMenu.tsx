import { Ellipsis, Eraser, Trash2 } from 'lucide-react';
import type { MenuEntry } from '../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { ViewerMenu } from './internal/ViewerMenu';
import type { LandingViewerSourceCapabilities } from './types';

/**
 * Everything that is rare or destructive, plus whatever the toolbar had to put away when
 * the window got narrow (`leading`). Each entry renders only when the source can do it.
 */
export function GalleryMoreMenu({
  running,
  hasActiveCatalog,
  capabilities,
  leading = [],
  onClearCache,
  onRemoveActiveCatalog
}: {
  running: boolean;
  hasActiveCatalog: boolean;
  capabilities: LandingViewerSourceCapabilities;
  leading?: ReadonlyArray<MenuEntry>;
  onClearCache: () => void;
  onRemoveActiveCatalog: () => void;
}) {
  const { t } = useI18n();
  const destructive: MenuEntry[] = [
    ...(capabilities.clearCache
      ? [
          {
            id: 'clear-cache',
            icon: <Eraser size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />,
            label: t('landingGalleryClearCache'),
            disabled: running,
            onSelect: onClearCache
          }
        ]
      : []),
    ...(capabilities.removeCatalog
      ? [
          {
            id: 'remove-catalog',
            icon: <Trash2 size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />,
            label: t('landingGalleryRemoveActiveCatalog'),
            destructive: true,
            disabled: running || !hasActiveCatalog,
            onSelect: onRemoveActiveCatalog
          }
        ]
      : [])
  ];
  if (!destructive.length && !leading.length) return null;
  return (
    <ViewerMenu
      label={t('landingGalleryMoreActions')}
      trigger={<Ellipsis size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
      items={[
        ...leading,
        ...(leading.length && destructive.length ? ['separator' as const] : []),
        ...destructive
      ]}
    />
  );
}
