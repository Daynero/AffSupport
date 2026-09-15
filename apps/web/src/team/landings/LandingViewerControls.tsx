import {
  DEFAULT_LANDING_VIEWER_PRESET,
  LANDING_ZOOM_MAX,
  LANDING_ZOOM_MIN,
  clampZoom,
  type LandingDevicePreset,
  type LandingViewerPreset
} from '@video-compressor/shared';
import { IconButton, SegmentedControl } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';

const DEVICE_LABELS: Record<LandingDevicePreset, TranslationKey> = {
  desktop: 'teamLandingDeviceDesktop',
  tablet: 'teamLandingDeviceTablet',
  mobile: 'teamLandingDeviceMobile'
};

const ZOOM_STEP = 0.25;

/**
 * Device / zoom presets for the team landing viewer. Presentational: it owns no persistence —
 * the caller passes the current preset and persists the change (feature 004, US2).
 *
 * The light/dark pair that used to sit between them is gone: a landing is rendered in the
 * scheme its own markup asks for, and a toggle over someone else's page only ever showed the
 * same page twice.
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
      <div className="landing-viewer-zoom" role="group" aria-label={t('teamLandingViewerZoom')}>
        <IconButton
          variant="outline"
          size="sm"
          label={`${t('teamLandingViewerZoom')} −`}
          disabled={preset.zoom <= LANDING_ZOOM_MIN}
          onClick={() => setZoom(preset.zoom - ZOOM_STEP)}
        >
          −
        </IconButton>
        <span className="landing-viewer-zoom-value">{Math.round(preset.zoom * 100)}%</span>
        <IconButton
          variant="outline"
          size="sm"
          label={`${t('teamLandingViewerZoom')} +`}
          disabled={preset.zoom >= LANDING_ZOOM_MAX}
          onClick={() => setZoom(preset.zoom + ZOOM_STEP)}
        >
          +
        </IconButton>
      </div>
    </div>
  );
}
