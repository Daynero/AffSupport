import { ChevronDown, Monitor, Moon, Smartphone, Sun, Tablet } from 'lucide-react';
import type { LandingPreviewDevice, LandingPreviewRenderSettings } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n, type TranslationKey } from '../i18n';
import { MenuHeading, MenuItem, MenuSeparator, ViewerMenu } from './internal/ViewerMenu';

const DEVICES: Array<{ value: LandingPreviewDevice; key: TranslationKey; icon: typeof Monitor }> = [
  { value: 'desktop', key: 'landingGalleryDeviceDesktop', icon: Monitor },
  { value: 'tablet', key: 'landingGalleryDeviceTablet', icon: Tablet },
  { value: 'mobile', key: 'landingGalleryDeviceMobile', icon: Smartphone }
];

/**
 * How the landings are rendered: which device's viewport and which colour scheme. The
 * trigger shows the current choice, so the toolbar says "Desktop · Light" without opening
 * anything.
 */
export function GallerySettingsMenu({
  settings,
  disabled,
  onChange
}: {
  settings: LandingPreviewRenderSettings;
  disabled: boolean;
  onChange: (partial: Partial<LandingPreviewRenderSettings>) => void;
}) {
  const { t } = useI18n();
  const device = DEVICES.find(entry => entry.value === settings.device) ?? DEVICES[0];
  const DeviceIcon = device.icon;
  return (
    <ViewerMenu
      label={t('landingGalleryPreviewSettings')}
      triggerClassName="has-label lv-preview-settings"
      disabled={disabled}
      trigger={
        <>
          <DeviceIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span className="action-label">
            {t(device.key)} ·{' '}
            {t(
              settings.colorScheme === 'dark'
                ? 'landingGalleryColorSchemeDark'
                : 'landingGalleryColorSchemeLight'
            )}
          </span>
          <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
        </>
      }
    >
      {close => (
        <>
          <MenuHeading>{t('landingGalleryDeviceLabel')}</MenuHeading>
          {DEVICES.map(entry => {
            const Icon = entry.icon;
            return (
              <MenuItem
                key={entry.value}
                icon={<Icon size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />}
                checked={settings.device === entry.value}
                onClick={() => {
                  close();
                  if (settings.device !== entry.value) onChange({ device: entry.value });
                }}
              >
                {t(entry.key)}
              </MenuItem>
            );
          })}
          <MenuSeparator />
          <MenuHeading>{t('landingGalleryColorSchemeLabel')}</MenuHeading>
          <MenuItem
            icon={<Sun size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            checked={settings.colorScheme === 'light'}
            onClick={() => {
              close();
              if (settings.colorScheme !== 'light') onChange({ colorScheme: 'light' });
            }}
          >
            {t('landingGalleryColorSchemeLight')}
          </MenuItem>
          <MenuItem
            icon={<Moon size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            checked={settings.colorScheme === 'dark'}
            onClick={() => {
              close();
              if (settings.colorScheme !== 'dark') onChange({ colorScheme: 'dark' });
            }}
          >
            {t('landingGalleryColorSchemeDark')}
          </MenuItem>
        </>
      )}
    </ViewerMenu>
  );
}
