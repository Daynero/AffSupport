import { ChevronDown, Monitor, Moon, Smartphone, Sun, Tablet } from 'lucide-react';
import type { LandingPreviewDevice, LandingPreviewRenderSettings } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n, type TranslationKey } from '../i18n';
import { ViewerMenu } from './internal/ViewerMenu';

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
      items={[
        { heading: t('landingGalleryDeviceLabel') },
        ...DEVICES.map(entry => {
          const Icon = entry.icon;
          return {
            id: `device-${entry.value}`,
            icon: <Icon size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />,
            label: t(entry.key),
            checked: settings.device === entry.value,
            onSelect: () => {
              if (settings.device !== entry.value) onChange({ device: entry.value });
            }
          };
        }),
        'separator',
        { heading: t('landingGalleryColorSchemeLabel') },
        {
          id: 'scheme-light',
          icon: <Sun size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />,
          label: t('landingGalleryColorSchemeLight'),
          checked: settings.colorScheme === 'light',
          onSelect: () => {
            if (settings.colorScheme !== 'light') onChange({ colorScheme: 'light' });
          }
        },
        {
          id: 'scheme-dark',
          icon: <Moon size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />,
          label: t('landingGalleryColorSchemeDark'),
          checked: settings.colorScheme === 'dark',
          onSelect: () => {
            if (settings.colorScheme !== 'dark') onChange({ colorScheme: 'dark' });
          }
        }
      ]}
    />
  );
}
