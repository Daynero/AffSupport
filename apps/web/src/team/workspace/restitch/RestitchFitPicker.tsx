/**
 * How a picture sits in the video's frame, shown rather than named (071).
 *
 * Each choice is a small upright frame with the same square picture in it — cropped at the
 * sides, letterboxed, or squeezed — because three pictograms of crop marks and arrows asked the
 * reader to imagine exactly what a thumbnail can simply show.
 */

import type { ImageFitMode } from '@video-compressor/shared';
import { RadioGroup } from '../../../components/ui/index';
import { useI18n } from '../../../i18n';

const FITS: readonly ImageFitMode[] = ['cover', 'contain', 'stretch'];
const LABELS = { cover: 'fitCover', contain: 'fitContain', stretch: 'fitStretch' } as const;

export function RestitchFitPicker({
  value,
  picture,
  disabled,
  onChange
}: {
  value: ImageFitMode;
  /** The picture the frames show: the space's own first one, or Soty's. */
  picture: string;
  disabled: boolean;
  onChange: (fit: ImageFitMode) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="field-group team-restitch-fit">
      <div className="field-label">
        <span>{t('teamRestitchFitTitle')}</span>
      </div>
      <RadioGroup
        className="team-restitch-fit-cards"
        variant="cards"
        label={t('teamRestitchFitTitle')}
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={FITS.map(fit => ({
          value: fit,
          label: t(LABELS[fit]),
          icon: (
            <span className="team-restitch-fit-frame" data-fit={fit}>
              <img src={picture} alt="" />
            </span>
          )
        }))}
      />
      {value === 'stretch' && <span className="field-hint">{t('fitStretchWarning')}</span>}
    </div>
  );
}
