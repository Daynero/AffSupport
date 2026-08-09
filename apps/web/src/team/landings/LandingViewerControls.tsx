import {
  DEFAULT_LANDING_VIEWER_PRESET,
  LANDING_ZOOM_MAX,
  LANDING_ZOOM_MIN,
  clampZoom,
  type LandingColorScheme,
  type LandingDevicePreset,
  type LandingViewerPreset
} from '@video-compressor/shared';
import { Button, SegmentedControl } from '../../components/ui';
import { useI18n, type TranslationKey } from '../../i18n';

const DEVICE_LABELS: Record<LandingDevicePreset, TranslationKey> = {
  desktop: 'teamLandingDeviceDesktop',
  tablet: 'teamLandingDeviceTablet',
  mobile: 'teamLandingDeviceMobile'
};

const SCHEME_LABELS: Record<LandingColorScheme, TranslationKey> = {
  light: 'teamLandingSchemeLight',
  dark: 'teamLandingSchemeDark'
};

const ZOOM_STEP = 0.25;

/**
 * Device / colour-scheme / zoom presets for the team landing viewer. Presentational: it owns no
 * persistence — the caller passes the current preset and persists the change (feature 004, US2).
 */
export function LandingViewerControls({
  preset = DEFAULT_LANDING_VIEWER_PRESET,
  onChange
}: {
  preset?: LandingViewerPreset;
  onChange: (preset: LandingViewerPreset) => void;
}) {
  const { t } = useI18n();
  const setZoom = (next: number) => onChange({ ...preset, zoom: clampZoom(next) });

  return (
    <div className="landing-viewer-controls" role="group" aria-label={t('teamLandingsOpenGallery')}>
      <SegmentedControl<LandingDevicePreset>
        label={t('teamLandingViewerDevice')}
        value={preset.device}
        onChange={device => onChange({ ...preset, device })}
        options={(Object.keys(DEVICE_LABELS) as LandingDevicePreset[]).map(value => ({
          value,
          label: t(DEVICE_LABELS[value])
        }))}
      />
      <SegmentedControl<LandingColorScheme>
        label={t('teamLandingViewerScheme')}
        value={preset.colorScheme}
        onChange={colorScheme => onChange({ ...preset, colorScheme })}
        options={(Object.keys(SCHEME_LABELS) as LandingColorScheme[]).map(value => ({
          value,
          label: t(SCHEME_LABELS[value])
        }))}
      />
      <div className="landing-viewer-zoom" role="group" aria-label={t('teamLandingViewerZoom')}>
        <Button
          type="button"
          aria-label={`${t('teamLandingViewerZoom')} −`}
          disabled={preset.zoom <= LANDING_ZOOM_MIN}
          onClick={() => setZoom(preset.zoom - ZOOM_STEP)}
        >
          −
        </Button>
        <span className="landing-viewer-zoom-value">{Math.round(preset.zoom * 100)}%</span>
        <Button
          type="button"
          aria-label={`${t('teamLandingViewerZoom')} +`}
          disabled={preset.zoom >= LANDING_ZOOM_MAX}
          onClick={() => setZoom(preset.zoom + ZOOM_STEP)}
        >
          +
        </Button>
      </div>
    </div>
  );
}
