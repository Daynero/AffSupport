/**
 * A space's re-stitch settings as the settings screen edits them (071).
 *
 * The form is the stored row minus the operation: the screen always saves `restitch`, which on a
 * video without screens adds them and on one with screens replaces them (`planStitch`). What a
 * space shows before anyone saved anything is what the server uses then — both slots on, Soty's
 * standard pictures, forty to fifty minutes (20261224170000_restitch_builtin_defaults.sql).
 */

import { RESTITCH_BUILTIN_SCREENS } from '@video-compressor/shared';
import type {
  ImageFitMode,
  RestitchPoolSummary,
  RestitchSlot,
  StartImageDurationMode,
  TeamRestitchDefaults
} from '@video-compressor/shared';
import { clampMinutes, type FinalDuration } from '../../../components/ui/index';

export interface RestitchForm {
  fitMode: ImageFitMode;
  finalDurationMode: TeamRestitchDefaults['finalDurationMode'];
  customFinalDurationSeconds: number;
  /** Seconds, whole minutes; only with `random-centered` (071). */
  finalDurationRangeSeconds: readonly [number, number] | null;
  startEnabled: boolean;
  endEnabled: boolean;
  startDurationMode: StartImageDurationMode;
  customStartDurationMs: number;
}

export const FORM_DEFAULTS: RestitchForm = {
  fitMode: 'cover',
  finalDurationMode: 'random-40-50',
  customFinalDurationSeconds: 45 * 60,
  finalDurationRangeSeconds: null,
  startEnabled: true,
  endEnabled: true,
  startDurationMode: 'one-frame',
  customStartDurationMs: 100
};

export function formOf(defaults: TeamRestitchDefaults | null): RestitchForm {
  if (!defaults) return FORM_DEFAULTS;
  return {
    fitMode: defaults.fitMode,
    finalDurationMode: defaults.finalDurationMode,
    finalDurationRangeSeconds: defaults.finalDurationRangeSeconds ?? null,
    // Whole minutes, 1–60: what the stitch can hold (`clampStitchEndDuration`) and what the
    // timeline can draw. A row of seconds from the old free field reads as its nearest minute.
    customFinalDurationSeconds: clampMinutes(defaults.customFinalDurationSeconds / 60) * 60,
    // Effective settings turn a slot that falls back to Soty's picture off for older agents;
    // `builtin` says it was on (20261224170000). A raw row has no marker and needs none.
    startEnabled: defaults.startEnabled !== false || defaults.builtin?.start === true,
    endEnabled: defaults.endEnabled !== false || defaults.builtin?.end === true,
    startDurationMode: defaults.startDurationMode ?? 'one-frame',
    customStartDurationMs: defaults.customStartDurationMs ?? 100
  };
}

/** The three ranges a space could store before 071, kept in their own words when chosen. */
const PRESETS = [
  ['random-30-40', 30, 40],
  ['random-40-50', 40, 50],
  ['random-50-60', 50, 60]
] as const;

/** The final picture's length as the timeline holds it: a range of minutes, equal when exact. */
export function durationOf(form: RestitchForm): FinalDuration {
  const minutes = clampMinutes(form.customFinalDurationSeconds / 60);
  if (form.finalDurationMode === 'custom') return { low: minutes, high: minutes };
  if (form.finalDurationMode === 'random-centered') {
    const range = form.finalDurationRangeSeconds;
    return range
      ? { low: clampMinutes(range[0] / 60), high: clampMinutes(range[1] / 60) }
      : { low: clampMinutes(minutes - 5), high: clampMinutes(minutes + 5) };
  }
  const preset = PRESETS.find(([mode]) => mode === form.finalDurationMode) ?? PRESETS[1];
  return { low: preset[1], high: preset[2] };
}

/**
 * …and back, in the words every reader of the row already knows. One length is `custom`; a range
 * that is one of the three old windows keeps that window's name, so agents and servers that
 * predate 071 draw exactly what was chosen; any other range is `random-centered` with the range
 * — the launch's word, which the server already draws from — and its middle as the centre, so a
 * reader that knows only the centre still lands within five minutes of it.
 */
export function withDuration(form: RestitchForm, duration: FinalDuration): RestitchForm {
  const low = clampMinutes(Math.min(duration.low, duration.high));
  const high = clampMinutes(Math.max(duration.low, duration.high));
  if (low === high)
    return {
      ...form,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: low * 60,
      finalDurationRangeSeconds: null
    };
  const preset = PRESETS.find(([, from, to]) => from === low && to === high);
  if (preset) return { ...form, finalDurationMode: preset[0], finalDurationRangeSeconds: null };
  return {
    ...form,
    finalDurationMode: 'random-centered',
    customFinalDurationSeconds: Math.round((low + high) / 2) * 60,
    finalDurationRangeSeconds: [low * 60, high * 60]
  };
}

/**
 * Whether Soty's standard picture stands in for a slot: on, and nothing of its own to draw.
 *
 * The same rule the server applies when it writes `builtin.<slot>` into the effective settings
 * (20261224170000). One function, so a contract field can replace it in one line.
 */
export function builtinSlot(enabled: boolean, pool: RestitchPoolSummary | null | undefined) {
  return enabled && (!pool || pool.eligibleCount === 0);
}

/** Soty's standard pictures, the very files the stitch uses (shared contract, findings.md). */
export const BUILTIN_PICTURES: Record<RestitchSlot, string> = {
  start: RESTITCH_BUILTIN_SCREENS.start.path,
  end: RESTITCH_BUILTIN_SCREENS.end.path
};

/** Off means both slots off: there is then nothing to stitch. */
export function restitchOff(form: RestitchForm): boolean {
  return !form.startEnabled && !form.endEnabled;
}
