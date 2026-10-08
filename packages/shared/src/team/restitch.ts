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
  clampCustomStartDurationMs,
  type FinalImageDurationMode,
  type ImageFitMode,
  type StartImageDurationMode
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
  startEnabled?: boolean;
  endEnabled?: boolean;
  startDurationMode?: StartImageDurationMode;
  customStartDurationMs?: number;
  /** Whether this set could actually produce a file; see `restitchDefaultsSaveable`. */
  configured: boolean;
  /**
   * Where the pictures come from (030). `legacy` rows keep drawing from the id lists above;
   * `drive` rows draw from the space's source pools and leave those lists empty.
   */
  sourceMode: RestitchSourceMode;
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
/**
 * Bumped whenever the detector would answer differently about the same bytes.
 *
 * A preparation record is a cached answer, and `driveVersion` only says the file has not
 * changed — it says nothing about whether the code that read it has. A build that taught the
 * detector to see through an old screen shipped, and every material already prepared kept
 * being cut by the answer the previous build had given: the fix was invisible on exactly the
 * files it was written for.
 *
 * 1: the tail walk measures a moving frame outside the held regions of the body, and is no
 *    longer capped at a tenth of the tail — a video stitched twice loses both screens.
 * 2: a variable frame rate is decided from the body's own packet spacing rather than from
 *    the file's average, which an end screen of up to forty-five minutes at one frame a
 *    second dragged far below the nominal rate. Every video this product re-stitched was
 *    refused on the next pass — and the refusal was cached, so it stayed refused.
 * 3: edge timing and body frame limits use the nominal cadence rather than an average
 *    diluted by sparse end screens. Re-read cached boundaries and source profiles.
 */
export const RESTITCH_DETECTOR_VERSION = 3;

export interface MaterialRestitchPrep {
  materialId: string;
  driveVersion: string;
  /** Which detector found these edges. See {@link RESTITCH_DETECTOR_VERSION}. */
  detectorVersion: number;
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
  defaults: Pick<
    TeamRestitchDefaults,
    'operation' | 'startImageIds' | 'endImageIds' | 'startEnabled' | 'endEnabled'
  > & { sourceMode?: RestitchSourceMode }
): boolean {
  if (defaults.operation === 'unstitch') return true;
  // Drive pools are resolved by the server at read time; the id lists say nothing about them.
  if (defaults.sourceMode === 'drive')
    return defaults.startEnabled !== false || defaults.endEnabled !== false;
  return (
    (defaults.startEnabled !== false && defaults.startImageIds.length > 0) ||
    (defaults.endEnabled !== false && defaults.endImageIds.length > 0)
  );
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
  const sourceMode = parseRestitchSourceMode(value.sourceMode);
  const custom = finite(value.customFinalDurationSeconds);
  return {
    ok: true,
    value: {
      operation,
      startImageIds,
      endImageIds,
      sourceMode,
      fitMode: oneOf(value.fitMode, RESTITCH_FIT_MODES, 'cover'),
      finalDurationMode: oneOf(value.finalDurationMode, RESTITCH_DURATION_MODES, 'random-40-50'),
      customFinalDurationSeconds: clampStitchEndDuration(
        custom ?? DEFAULT_CUSTOM_FINAL_IMAGE_DURATION_SECONDS
      ),
      startEnabled: value.startEnabled !== false,
      endEnabled: value.endEnabled !== false,
      startDurationMode: oneOf(
        value.startDurationMode,
        ['one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom'] as const,
        'one-frame'
      ),
      customStartDurationMs: clampCustomStartDurationMs(value.customStartDurationMs),
      // Never trusted from the row: a set that cannot produce a file is not configured,
      // whatever a caller wrote there.
      configured:
        value.configured === true &&
        restitchDefaultsSaveable({
          operation,
          startImageIds,
          endImageIds,
          sourceMode,
          startEnabled: value.startEnabled !== false,
          endEnabled: value.endEnabled !== false
        }),
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
      // Absent means a record written before the detector was versioned, which is exactly the
      // case this exists to retire: zero is never the current version.
      detectorVersion: Math.max(0, Math.trunc(finite(value.detectorVersion) ?? 0)),
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
  if (prep.driveVersion !== driveVersion) return null;
  // The file is the same; the reading of it may not be. A record from an older detector is
  // treated as no record — the run inspects for itself and stores the newer answer.
  return prep.detectorVersion === RESTITCH_DETECTOR_VERSION ? prep : null;
}

// ---------------------------------------------------------------------------------------------
// Feature 030 — the pictures come from the space, not from a server bucket.
//
// A space no longer publishes its owner's local library; it records *sources* (image files
// and folders of the connected Drive), the server resolves them into an effective set and
// draws one picture per slot for each job, and the member's agent fetches only that picture
// through the same download grants a video travels on. Everything below is the wire shape of
// that, with a guard for each side of each boundary.
// ---------------------------------------------------------------------------------------------

/**
 * Which way a space's settings point: at ids in the owner's local library (`legacy`, the
 * bucket era) or at materials of the connected Drive (`drive`). A row written before this
 * field existed is `legacy` — that is exactly the row the migration banner is for.
 */
export type RestitchSourceMode = 'legacy' | 'drive';

/** The claim/process contract version the web speaks. Old tabs send nothing, which reads as 1. */
export const RESTITCH_CONTRACT_VERSION = 2;
/** The most pictures one slot's effective set may hold. The same bound the catalog pools use. */
export const RESTITCH_POOL_LIMIT = 500;
/** The agent's own ceiling for one picture; the server filters on it at selection time. */
export const RESTITCH_SCREEN_MAX_BYTES = 50 * 1024 * 1024;
export const RESTITCH_SCREEN_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type RestitchScreenMimeType = (typeof RESTITCH_SCREEN_MIME_TYPES)[number];

export const RESTITCH_SLOTS = ['start', 'end'] as const;
export type RestitchSlot = (typeof RESTITCH_SLOTS)[number];
export type RestitchSourceKind = 'file' | 'folder';
export const RESTITCH_SOURCE_AVAILABILITY = [
  'available',
  'trashed',
  'missing',
  'out_of_root',
  'unsupported',
  'pending',
  'disconnected'
] as const;
export type RestitchSourceAvailability = (typeof RESTITCH_SOURCE_AVAILABILITY)[number];
export const RESTITCH_POOL_STATES = ['ready', 'partial', 'empty'] as const;
export type RestitchPoolState = (typeof RESTITCH_POOL_STATES)[number];

/** One thing a pool points at, with what the catalog currently knows about it. */
export interface RestitchSource {
  materialId: string | null;
  /** Set while the folder has been chosen but the catalog has not indexed it yet. */
  driveFileId: string | null;
  kind: RestitchSourceKind;
  name: string;
  availability: RestitchSourceAvailability;
  /** Eligible pictures this source contributes (1 for a usable file, a count for a folder). */
  imageCount: number;
  skipped: { format: number; size: number; animated: number };
}

export interface RestitchPoolSummary {
  state: RestitchPoolState;
  overLimit: boolean;
  eligibleCount: number;
  sources: RestitchSource[];
}

export interface RestitchSourcesListing {
  sourceMode: RestitchSourceMode;
  /** How many ids the legacy columns still hold — the number on the "re-pick" banner. */
  legacyImageCount: number;
  pools: Record<RestitchSlot, RestitchPoolSummary>;
}

/** What the browser hands `set_restitch_sources`. */
export type RestitchSourceInput = { materialId: string } | { driveFileId: string; kind: 'folder' };

/** One picture the server drew for one job, and how the agent may fetch it. */
export interface RestitchScreen {
  slot: RestitchSlot;
  materialId: string;
  /** The catalog's md5 of the bytes — the agent's cache key together with the material id. */
  checksum: string;
  mimeType: RestitchScreenMimeType;
  fileName: string;
  sizeBytes: number;
  /** Absent means "only what the agent already has"; present means a download grant. */
  transfer: { transferUrl: string; grant: RestitchTransferGrant } | null;
}

/**
 * The grant as the agent already understands it (`TeamTransferGrant` in transport.ts),
 * restated structurally so this file keeps no import into the transport module.
 */
export interface RestitchTransferGrant {
  ticket: string;
  purpose: string;
  expiresAt: string;
  maxRangeBytes: number;
  maxUses: number;
}

export interface RestitchDrawResult {
  sourceMode: RestitchSourceMode;
  pool: Record<RestitchSlot, RestitchPoolState>;
  screens: Array<Omit<RestitchScreen, 'transfer'> & { driveVersion: string | null }>;
}

function nonNegativeInt(value: unknown): number {
  const parsed = finite(value);
  return parsed === null ? 0 : Math.max(0, Math.trunc(parsed));
}

function slotOf(value: unknown): RestitchSlot | null {
  return value === 'start' || value === 'end' ? value : null;
}

function screenMime(value: unknown): RestitchScreenMimeType | null {
  return (RESTITCH_SCREEN_MIME_TYPES as readonly string[]).includes(value as string)
    ? (value as RestitchScreenMimeType)
    : null;
}

export function parseRestitchSourceMode(value: unknown): RestitchSourceMode {
  return value === 'drive' ? 'drive' : 'legacy';
}

function parseRestitchSource(value: unknown): RestitchSource | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === 'file' || value.kind === 'folder' ? value.kind : null;
  const materialId =
    typeof value.materialId === 'string' && value.materialId ? value.materialId : null;
  const driveFileId =
    typeof value.driveFileId === 'string' && value.driveFileId ? value.driveFileId : null;
  if (!kind || (!materialId && !driveFileId)) return null;
  const availability = (RESTITCH_SOURCE_AVAILABILITY as readonly string[]).includes(
    value.availability as string
  )
    ? (value.availability as RestitchSourceAvailability)
    : null;
  if (!availability) return null;
  const skipped = isRecord(value.skipped) ? value.skipped : {};
  return {
    materialId,
    driveFileId,
    kind,
    name: typeof value.name === 'string' ? value.name : '',
    availability,
    imageCount: nonNegativeInt(value.imageCount),
    skipped: {
      format: nonNegativeInt(skipped.format),
      size: nonNegativeInt(skipped.size),
      animated: nonNegativeInt(skipped.animated)
    }
  };
}

function parseRestitchPool(value: unknown): RestitchPoolSummary | null {
  if (!isRecord(value)) return null;
  const state = (RESTITCH_POOL_STATES as readonly string[]).includes(value.state as string)
    ? (value.state as RestitchPoolState)
    : null;
  if (!state || !Array.isArray(value.sources)) return null;
  const sources: RestitchSource[] = [];
  for (const entry of value.sources) {
    const source = parseRestitchSource(entry);
    // One unreadable source is a listing nobody can act on: the pool it belongs to is unknown.
    if (!source) return null;
    sources.push(source);
  }
  return {
    state,
    overLimit: value.overLimit === true,
    eligibleCount: nonNegativeInt(value.eligibleCount),
    sources
  };
}

/** `list_restitch_sources`, off the wire. Strict: a pool that cannot be read is no listing. */
export function parseRestitchSourcesListing(value: unknown): RestitchParse<RestitchSourcesListing> {
  if (!isRecord(value) || !isRecord(value.pools)) {
    return { ok: false, error: 'RESTITCH_SOURCES_INVALID' };
  }
  const start = parseRestitchPool(value.pools.start);
  const end = parseRestitchPool(value.pools.end);
  if (!start || !end) return { ok: false, error: 'RESTITCH_SOURCES_INVALID' };
  return {
    ok: true,
    value: {
      sourceMode: parseRestitchSourceMode(value.sourceMode),
      legacyImageCount: nonNegativeInt(value.legacyImageCount),
      pools: { start, end }
    }
  };
}

function parseDrawnScreen(value: unknown): RestitchDrawResult['screens'][number] | null {
  if (!isRecord(value)) return null;
  const slot = slotOf(value.slot);
  const mimeType = screenMime(value.mimeType);
  const materialId = typeof value.materialId === 'string' ? value.materialId : '';
  const checksum = typeof value.checksum === 'string' ? value.checksum : '';
  const sizeBytes = finite(value.sizeBytes);
  if (!slot || !mimeType || !materialId || !checksum || sizeBytes === null || sizeBytes <= 0) {
    return null;
  }
  return {
    slot,
    materialId,
    checksum,
    mimeType,
    fileName: typeof value.fileName === 'string' && value.fileName ? value.fileName : materialId,
    sizeBytes,
    driveVersion: typeof value.driveVersion === 'string' ? value.driveVersion : null
  };
}

/** `draw_restitch_screens`, off the wire. Strict: one bad screen refuses the draw. */
export function parseRestitchDrawResult(value: unknown): RestitchParse<RestitchDrawResult> {
  if (!isRecord(value) || !Array.isArray(value.screens)) {
    return { ok: false, error: 'RESTITCH_DRAW_INVALID' };
  }
  const pool = isRecord(value.pool) ? value.pool : {};
  const poolState = (entry: unknown): RestitchPoolState =>
    (RESTITCH_POOL_STATES as readonly string[]).includes(entry as string)
      ? (entry as RestitchPoolState)
      : 'empty';
  const screens: RestitchDrawResult['screens'] = [];
  for (const entry of value.screens) {
    const screen = parseDrawnScreen(entry);
    if (!screen) return { ok: false, error: 'RESTITCH_DRAW_INVALID' };
    screens.push(screen);
  }
  return {
    ok: true,
    value: {
      sourceMode: parseRestitchSourceMode(value.sourceMode),
      pool: { start: poolState(pool.start), end: poolState(pool.end) },
      screens
    }
  };
}

function parseTransfer(value: unknown): RestitchScreen['transfer'] | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.transferUrl !== 'string' || !isRecord(value.grant)) {
    return undefined;
  }
  const grant = value.grant;
  const maxRangeBytes = finite(grant.maxRangeBytes);
  const maxUses = finite(grant.maxUses);
  if (
    typeof grant.ticket !== 'string' ||
    typeof grant.purpose !== 'string' ||
    typeof grant.expiresAt !== 'string' ||
    maxRangeBytes === null ||
    maxUses === null
  ) {
    return undefined;
  }
  return {
    transferUrl: value.transferUrl,
    grant: {
      ticket: grant.ticket,
      purpose: grant.purpose,
      expiresAt: grant.expiresAt,
      maxRangeBytes,
      maxUses
    }
  };
}

/**
 * The screens a job carries into the agent, off the wire.
 *
 * Strict, and all-or-nothing: a job with one unreadable screen would otherwise be cut with
 * the other one and look finished. `undefined` and `null` both mean "no screens were sent",
 * which is the legacy path and not an error.
 */
export function parseRestitchScreens(value: unknown): RestitchParse<RestitchScreen[] | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: 'RESTITCH_SCREENS_INVALID' };
  const screens: RestitchScreen[] = [];
  for (const entry of value) {
    const drawn = parseDrawnScreen(entry);
    const transfer = isRecord(entry) ? parseTransfer(entry.transfer) : undefined;
    if (!drawn || transfer === undefined) return { ok: false, error: 'RESTITCH_SCREENS_INVALID' };
    const { driveVersion: _driveVersion, ...screen } = drawn;
    screens.push({ ...screen, transfer });
  }
  return { ok: true, value: screens };
}
