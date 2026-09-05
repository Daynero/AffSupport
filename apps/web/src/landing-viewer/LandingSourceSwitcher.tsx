import { ChevronDown, Folder, FolderInput, Users } from 'lucide-react';
import type { LandingPreviewCatalogSummary } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { MenuItem, MenuSeparator, ViewerMenu } from './internal/ViewerMenu';

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
    >
      {close => (
        <>
          {catalogs.map(catalog => {
            const Icon = catalog.sourceKind === 'team' ? Users : Folder;
            return (
              <MenuItem
                key={catalog.id}
                icon={<Icon size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />}
                title={catalog.name}
                detail={
                  catalog.sourceAvailable
                    ? t('landingGalleryCount', { count: catalog.landingCount })
                    : t('landingGalleryUnavailable')
                }
                current={catalog.id === activeCatalogId}
                disabled={disabled}
                onClick={() => {
                  close();
                  if (catalog.id !== activeCatalogId) onActivate(catalog.id);
                }}
              />
            );
          })}
          {canChooseFolder && (
            <>
              <MenuSeparator />
              <MenuItem
                className="is-add"
                icon={
                  <FolderInput size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />
                }
                disabled={disabled}
                onClick={() => {
                  close();
                  onChooseFolder();
                }}
              >
                {t('landingGalleryChooseAnother')}
              </MenuItem>
            </>
          )}
        </>
      )}
    </ViewerMenu>
  );
}
