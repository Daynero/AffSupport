import { ChevronDown, Folder, FolderInput, Users } from 'lucide-react';
import type { LandingPreviewCatalogSummary } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { ViewerMenu } from './internal/ViewerMenu';

/**
 * The open folder's name, which is also how another folder is chosen: the menu lists every
 * folder opened before and ends with the picker.
 */
export function LandingSourceSwitcher({
  catalogs,
  activeCatalogId,
  activeCatalogName,
  landingCount,
  disabled,
  canChooseFolder,
  onActivate,
  onChooseFolder
}: {
  catalogs: LandingPreviewCatalogSummary[];
  activeCatalogId: string | null;
  activeCatalogName: string | null;
  landingCount: number;
  disabled: boolean;
  canChooseFolder: boolean;
  onActivate: (id: string) => void;
  onChooseFolder: () => void;
}) {
  const { t } = useI18n();
  const active = catalogs.find(catalog => catalog.id === activeCatalogId);
  const ActiveIcon = active?.sourceKind === 'team' ? Users : Folder;
  return (
    <ViewerMenu
      label={t('landingGallerySwitchSource')}
      align="start"
      triggerClassName="lv-source"
      trigger={
        <>
          <ActiveIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span className="lv-source-copy">
            <strong>{activeCatalogName}</strong>
            <small>{t('landingGalleryCount', { count: landingCount })}</small>
          </span>
          <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
        </>
      }
      items={[
        // The open folder is the answer to "which folder", ticked; the picker after the
        // line is a command of its own.
        ...catalogs.map(catalog => {
          const Icon = catalog.sourceKind === 'team' ? Users : Folder;
          return {
            id: `catalog-${catalog.id}`,
            icon: <Icon size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />,
            label: catalog.name,
            note: catalog.sourceAvailable
              ? t('landingGalleryCount', { count: catalog.landingCount })
              : t('landingGalleryUnavailable'),
            checked: catalog.id === activeCatalogId,
            disabled,
            onSelect: () => {
              if (catalog.id !== activeCatalogId) onActivate(catalog.id);
            }
          };
        }),
        ...(canChooseFolder
          ? [
              'separator' as const,
              {
                id: 'choose-folder',
                icon: (
                  <FolderInput size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />
                ),
                label: t('landingGalleryChooseAnother'),
                disabled,
                onSelect: onChooseFolder
              }
            ]
          : [])
      ]}
    />
  );
}
