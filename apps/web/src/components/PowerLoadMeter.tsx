import { useState } from 'react';
import type { SotyLoad } from '@video-compressor/shared';

/**
 * The header power button's load meter: a few bars that rise and fall with how hard Soty is
 * working the computer, the figure itself, and the bolt shrunk above it.
 *
 * Honest first, lively second. The bars' heights average to the reading exactly — only
 * their order changes from one reading to the next, the way an equaliser's bands trade
 * places — and the breathing between readings is a small dip below that height, never a
 * rise above it. Under reduced motion the breathing stops and the level just steps.
 *
 * The figure is Soty's own — its processes, not the machine's — so there is no background
 * to filter out: whatever it shows is Soty working. Below a percent or two Soty is doing
 * nothing a person would call work (the agent answering the page), and the button is the
 * plain bolt. The two thresholds differ so a reading idling at the edge does not make the
 * meter blink on and off every second. The panel's line takes `showing` from here rather
 * than deciding again, so the button and the sentence beneath it always agree.
 */

/** At or above this the meter appears. */
export const LOAD_METER_SHOW_AT = 2;
/** Below this it goes away again. */
export const LOAD_METER_HIDE_BELOW = 1;

/** Relative band heights; one row per reading, taken in turn. */
const PROFILES = [
  [0.72, 1, 0.84, 0.6],
  [1, 0.7, 0.92, 0.78],
  [0.8, 0.62, 1, 0.86],
  [0.64, 0.9, 0.74, 1]
] as const;
/** A band never vanishes while the meter is on: a flat bar reads as a broken one. */
const MIN_BAND = 0.06;

export interface LoadMeter {
  showing: boolean;
  /** The figure on the button; the last one shown while the meter fades away. */
  percent: number;
  /** Each band's height, 0–1 of the button. */
  bands: number[];
  /** Custom properties for the button's container: how warm the colour runs. */
  style: Record<string, string>;
}

interface Tracked {
  sampledAt: string | null;
  beat: number;
  showing: boolean;
  percent: number;
}

export function useLoadMeter(load: SotyLoad | null): LoadMeter {
  const reading = load?.availability === 'ok' ? load : null;
  const [tracked, setTracked] = useState<Tracked>({
    sampledAt: null,
    beat: 0,
    showing: false,
    percent: 0
  });

  const showing =
    reading === null
      ? false
      : reading.percent >= LOAD_METER_SHOW_AT
        ? true
        : reading.percent < LOAD_METER_HIDE_BELOW
          ? false
          : tracked.showing;
  const sampledAt = reading?.sampledAt ?? null;
  // Adjusted while rendering rather than in an effect, so the button never paints one frame
  // with the previous reading's decision.
  if (showing !== tracked.showing || (reading && sampledAt !== tracked.sampledAt)) {
    setTracked({
      sampledAt,
      beat: reading && sampledAt !== tracked.sampledAt ? tracked.beat + 1 : tracked.beat,
      showing,
      percent: reading ? reading.percent : tracked.percent
    });
  }

  const percent = reading ? reading.percent : tracked.percent;
  return {
    showing,
    percent,
    bands: showing ? loadBands(percent, tracked.beat) : PROFILES[0].map(() => 0),
    style: { '--load-heat': loadHeat(percent).toFixed(2) }
  };
}

/** Band heights whose mean is the reading, in the order this beat deals them. */
export function loadBands(percent: number, beat: number): number[] {
  const profile = PROFILES[((beat % PROFILES.length) + PROFILES.length) % PROFILES.length];
  const mean = profile.reduce((sum, value) => sum + value, 0) / profile.length;
  const level = Math.min(100, Math.max(0, percent)) / 100;
  return profile.map(value => round(Math.min(1, Math.max(MIN_BAND, (level * value) / mean))));
}

/**
 * How far the colour has warmed, 0–1: calm through ordinary work, warming from about a
 * third, fully at the warning colour near the top. A meter that turned amber at half load
 * would cry wolf at every export.
 */
export function loadHeat(percent: number): number {
  return round(Math.min(1, Math.max(0, (percent - 35) / 60)));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function PowerLoadMeter({ meter }: { meter: LoadMeter }) {
  return (
    <>
      <span className="power-meter" aria-hidden="true">
        {meter.bands.map((band, index) => (
          <span
            // The bands are positions, not items: the fourth is always the fourth.
            key={index}
            className="power-meter__band"
            style={{ '--band-level': String(band) } as Record<string, string>}
          >
            <span className="power-meter__fill" />
          </span>
        ))}
      </span>
      <span className="power-toggle__load" aria-hidden="true">
        {meter.percent}
        <span className="power-toggle__unit">%</span>
      </span>
    </>
  );
}
