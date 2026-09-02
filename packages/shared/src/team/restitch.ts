/**
 * What a space remembers about re-stitching, and what a run already knows about a material.
 *
 * Three shapes, all of which cross a process boundary — the browser to Postgres, the browser
 * to the local agent, the agent back again — so each has a guard and none is ever cast.
 *
 * Every setting here is one the stitcher already has. That is deliberate: a space's defaults
 * are the tool's own controls with an answer filled in, not a second vocabulary for the same
 * choices. Nothing in this file declares a new bound; the hold length is clamped by
 * `clampStitchEndDuration`, which the tools already use.
 */

import {
  clampStitchEndDuration,
  parseSourceProfile,
  type SourceProfile,
  type StitchOperation
} from '../stitcher.js';
import {
  DEFAULT_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
  type FinalImageDurationMode,
  type ImageFitMode
} from '../types.js';

export const RESTITCH_OPERATIONS = ['restitch', 'stitch', 'unstitch'] as const;
export const RESTITCH_FIT_MODES = ['cover', 'contain', 'stretch'] as const;
export const RESTITCH_DURATION_MODES = [
  'random-30-40',
  'random-40-50',
  'random-50-60',
  'custom'
] as const;

/** One answer per space, shared by everyone in it. */
export interface TeamRestitchDefaults {
  operation: StitchOperation;
  /** Which of the compressor's images may be drawn — ids, never the images themselves. */
  startImageIds: string[];
  endImageIds: string[];
  fitMode: ImageFitMode;
  finalDurationMode: FinalImageDurationMode;
  customFinalDurationSeconds: number;
  /** Whether this set could actually produce a file; see `restitchDefaultsSaveable`. */
  configured: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * What was found in one material, and what a cut of it needs to know.
 *
 * Keyed by the material's `driveVersion` because that is the whole invalidation rule: this
 * describes a file's bytes, so it stays true exactly as long as those bytes do. It says
 * nothing about photos, fit modes or hold lengths — which is why changing the space's
 * defaults leaves every one of these standing.
 */
export interface MaterialRestitchPrep {
  materialId: string;
  driveVersion: string;
  detectedStartSeconds: number;
  detectedEndSeconds: number;
  /**
   * What a cut of this file needs to know — absent when there is nothing to cut.
   *
   * A material the fast path cannot serve has no usable profile and needs none: the record
   * exists to say "we looked, and the answer is no", which is worth storing precisely so the
   * looking is not repeated.
   */
  profile: SourceProfile | null;
  /** Set when the fast path cannot serve this file at all, so the answer is not recomputed. */
  unsupportedReason: string | null;
  preparedAt: string;
}

/** One material's place in a preparation run. */
export interface TeamRestitchPrepareProgress {
  materialId: string;
  state: 'inspecting' | 'prepared' | 'unsupported' | 'failed';
  done: number;
  total: number;
  prep: MaterialRestitchPrep | null;
  reason: string | null;
}

export type RestitchParse<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Could this set produce a file at all?
 *
 * The one predicate behind the refusal, written once and used by both the settings screen and
 * the contract that stores them — so the interface cannot offer a save the database will
 * reject, and the database cannot accept a set the interface would not have offered.
 *
 * Removing the stitching needs no photograph. Everything else needs somewhere to draw one.
 */
export function restitchDefaultsSaveable(
  defaults: Pick<TeamRestitchDefaults, 'operation' | 'startImageIds' | 'endImageIds'>
): boolean {
  if (defaults.operation === 'unstitch') return true;
  return defaults.startImageIds.length > 0 || defaults.endImageIds.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A space's defaults, off the wire.
 *
 * Total rather than strict: a row written by an older build, or one whose enum drifted, comes
 * back as the nearest sensible answer rather than as a failure that would leave a space unable
 * to open its own settings. The only hard requirement is that it is an object at all.
 */
export function parseTeamRestitchDefaults(value: unknown): RestitchParse<TeamRestitchDefaults> {
  if (!isRecord(value)) return { ok: false, error: 'RESTITCH_DEFAULTS_INVALID' };
  const operation = oneOf(value.operation, RESTITCH_OPERATIONS, 'restitch');
  const startImageIds = stringList(value.startImageIds);
  const endImageIds = stringList(value.endImageIds);
  const custom = finite(value.customFinalDurationSeconds);
  return {
    ok: true,
    value: {
      operation,
      startImageIds,
      endImageIds,
      fitMode: oneOf(value.fitMode, RESTITCH_FIT_MODES, 'cover'),
      finalDurationMode: oneOf(value.finalDurationMode, RESTITCH_DURATION_MODES, 'random-40-50'),
      customFinalDurationSeconds: clampStitchEndDuration(
        custom ?? DEFAULT_CUSTOM_FINAL_IMAGE_DURATION_SECONDS
      ),
      // Never trusted from the row: a set that cannot produce a file is not configured,
      // whatever a caller wrote there.
      configured:
        value.configured === true &&
        restitchDefaultsSaveable({ operation, startImageIds, endImageIds }),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : null
    }
  };
}

/**
 * What a previous inspection found, off the wire.
 *
 * Strict, unlike the defaults: a preparation record that cannot be trusted must be treated as
 * absent, because acting on a wrong one produces a wrong file rather than an awkward screen.
 */
export function parseMaterialRestitchPrep(value: unknown): RestitchParse<MaterialRestitchPrep> {
  if (!isRecord(value)) return { ok: false, error: 'RESTITCH_PREP_INVALID' };
  const materialId = typeof value.materialId === 'string' ? value.materialId : '';
  const driveVersion = typeof value.driveVersion === 'string' ? value.driveVersion : '';
  const start = finite(value.detectedStartSeconds);
  const end = finite(value.detectedEndSeconds);
  if (!materialId || !driveVersion || start === null || end === null || start < 0 || end < 0)
    return { ok: false, error: 'RESTITCH_PREP_INCOMPLETE' };
  const unsupportedReason =
    typeof value.unsupportedReason === 'string' && value.unsupportedReason
      ? value.unsupportedReason
      : null;
  const profile = parseSourceProfile(value.profile);
  // A servable material must carry a profile a cut can trust; a refusal carries none, and
  // demanding one would mean re-deriving the refusal on every single delivery.
  if (!profile.ok && !unsupportedReason) return { ok: false, error: profile.error };
  return {
    ok: true,
    value: {
      materialId,
      driveVersion,
      detectedStartSeconds: start,
      detectedEndSeconds: end,
      profile: profile.ok ? profile.value : null,
      unsupportedReason,
      preparedAt: typeof value.preparedAt === 'string' ? value.preparedAt : ''
    }
  };
}

/** One progress event from a preparation run. */
export function parseTeamRestitchPrepareProgress(
  value: unknown
): RestitchParse<TeamRestitchPrepareProgress> {
  if (!isRecord(value)) return { ok: false, error: 'RESTITCH_PROGRESS_INVALID' };
  const materialId = typeof value.materialId === 'string' ? value.materialId : '';
  const state = value.state;
  if (
    !materialId ||
    (state !== 'inspecting' &&
      state !== 'prepared' &&
      state !== 'unsupported' &&
      state !== 'failed')
  ) {
    return { ok: false, error: 'RESTITCH_PROGRESS_INVALID' };
  }
  const prep =
    value.prep === undefined || value.prep === null ? null : parseMaterialRestitchPrep(value.prep);
  return {
    ok: true,
    value: {
      materialId,
      state,
      done: Math.max(0, finite(value.done) ?? 0),
      total: Math.max(0, finite(value.total) ?? 0),
      prep: prep && prep.ok ? prep.value : null,
      reason: typeof value.reason === 'string' && value.reason ? value.reason : null
    }
  };
}

/**
 * A preparation record is only usable while it still describes the file in front of us.
 *
 * The one place that decides it, so a caller cannot forget: a version mismatch is not an
 * error, it simply means nothing was prepared.
 */
export function usablePrep(
  prep: MaterialRestitchPrep | null,
  driveVersion: string | null
): MaterialRestitchPrep | null {
  if (!prep || !driveVersion) return null;
  return prep.driveVersion === driveVersion ? prep : null;
}
