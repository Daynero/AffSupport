import type { FinalImageDurationMode } from '@video-compressor/shared';
import { Button } from './Button';
import { DurationSlider } from './DurationSlider';

/** Seconds at the boundary; the control displays whole minutes on a 1–60 scale. */
export interface RestitchDurationValue {
  finalDurationMode: FinalImageDurationMode;
  customFinalDurationSeconds?: number | null;
  finalDurationRangeSeconds?: readonly [number, number];
}

export interface RestitchDurationControlProps {
  value: RestitchDurationValue;
  disabled?: boolean;
  labels: { duration: string; range: string; exact: string; unit: string };
  onChange: (value: RestitchDurationValue) => void;
}

function centeredRange(center: number): readonly [number, number] {
  return [Math.max(1, center - 5), Math.min(60, center + 5)];
}

function sliderValue(value: RestitchDurationValue): readonly [number, number] {
  const minutes = Math.round((value.customFinalDurationSeconds ?? 30 * 60) / 60);
  if (value.finalDurationMode === 'custom') return [minutes, 0];
  if (value.finalDurationMode === 'random-centered') {
    return value.finalDurationRangeSeconds
      ? [value.finalDurationRangeSeconds[0] / 60, value.finalDurationRangeSeconds[1] / 60]
      : centeredRange(minutes);
  }
  if (value.finalDurationMode === 'random-50-60') return [50, 60];
  if (value.finalDurationMode === 'random-40-50') return [40, 50];
  return [30, 40];
}

/** Shared presentation and mode conversion; callers own persistence and diagnostics. */
export function RestitchDurationControl({
  value,
  disabled,
  labels,
  onChange
}: RestitchDurationControlProps) {
  const range = value.finalDurationMode !== 'custom';
  const current = sliderValue(value);
  const commit = (minutes: readonly [number, number], useRange: boolean) => {
    if (disabled) return;
    onChange({
      finalDurationMode: useRange ? 'random-centered' : 'custom',
      customFinalDurationSeconds:
        (useRange ? Math.round((minutes[0] + minutes[1]) / 2) : minutes[0]) * 60,
      finalDurationRangeSeconds: useRange ? [minutes[0] * 60, minutes[1] * 60] : undefined
    });
  };
  return (
    <div className="restitch-duration-control">
      <DurationSlider
        value={current}
        range={range}
        disabled={disabled}
        label={range ? labels.range : labels.duration}
        unit={labels.unit}
        modeAction={
          <Button
            size="xs"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              const center = range ? Math.round((current[0] + current[1]) / 2) : current[0];
              // Preserve the selected point as the legacy center when opening a clipped window.
              if (!range) {
                const next = centeredRange(center);
                onChange({
                  finalDurationMode: 'random-centered',
                  customFinalDurationSeconds: center * 60,
                  finalDurationRangeSeconds: [next[0] * 60, next[1] * 60]
                });
              } else commit([center, 0], false);
            }}
          >
            {range ? labels.exact : labels.range}
          </Button>
        }
        onCommit={minutes => commit(minutes, range)}
      />
    </div>
  );
}
