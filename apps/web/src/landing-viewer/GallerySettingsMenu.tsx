import type { LandingPreviewDevice, LandingPreviewRenderSettings } from '@video-compressor/shared';
import { useI18n, type TranslationKey } from '../i18n';

const DEVICE_OPTIONS: Array<{ value: LandingPreviewDevice; key: TranslationKey }> = [
  { value: 'desktop', key: 'landingGalleryDeviceDesktop' },
  { value: 'tablet', key: 'landingGalleryDeviceTablet' },
  { value: 'mobile', key: 'landingGalleryDeviceMobile' }
];

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
  return (
    <details className="landing-gallery-settings">
      <summary
        className="landing-gallery-delayed-tooltip"
        data-tooltip={t('landingGalleryViewSettings')}
        aria-label={t('landingGalleryViewSettings')}
      >
        ⚙
      </summary>
      <div>
        <fieldset disabled={disabled}>
          <legend>{t('landingGalleryDeviceLabel')}</legend>
          <div className="landing-gallery-segment">
            {DEVICE_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                aria-pressed={settings.device === option.value}
                onClick={() => onChange({ device: option.value })}
              >
                {t(option.key)}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={disabled}>
          <legend>{t('landingGalleryColorSchemeLabel')}</legend>
          <div className="landing-gallery-segment">
            <button
              type="button"
              aria-pressed={settings.colorScheme === 'light'}
              onClick={() => onChange({ colorScheme: 'light' })}
            >
              {t('landingGalleryColorSchemeLight')}
            </button>
            <button
              type="button"
              aria-pressed={settings.colorScheme === 'dark'}
              onClick={() => onChange({ colorScheme: 'dark' })}
            >
              {t('landingGalleryColorSchemeDark')}
            </button>
          </div>
        </fieldset>
      </div>
    </details>
  );
}
