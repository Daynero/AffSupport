/**
 * Re-stitching one team material, for a member who asked to download it re-stitched.
 *
 * This is a delegate in the same sense as `compressor` and `imageEmbedding`: the bridge has
 * already fetched the source, hands it over with a workspace, and takes back a finished file.
 * What it does with it is feature 014's pipeline, unchanged — the body is copied, never
 * re-encoded, and only the screens are made.
 *
 * It drives the pipeline directly rather than through `StitchQueue`, and that is deliberate: a
 * delivery is not a row in anybody's list. Putting it in the queue would leave a stranger's
 * material sitting in the member's own stitcher page, and the queue's rules about order and
 * installation are about that list, not about this. Cancellation still arrives the same way,
 * through the delegate's signal, and every child still goes through the shared spawn seam, so
 * the power governor sees them exactly as it sees everything else.
 *
 * The one thing worth understanding here is what it *skips*. Reading a long file's keyframe
 * index and searching it for existing screens costs six to fourteen seconds and depends on
 * nothing but the file's bytes, so when the caller already knows the answer it is not asked
 * again. That skip is the whole reason a prepared space can promise ten seconds.
 */

import { stat } from 'node:fs/promises';
import {
  parseMaterialRestitchPrep,
  parseTeamRestitchDefaults,
  planStitch,
  type ImageEmbeddingSettings,
  type MaterialRestitchPrep,
  type SourceProfile,
  type StitchScreens,
  type StitchUnsupportedReason,
  type TeamRestitchDefaults,
  RESTITCH_DETECTOR_VERSION
} from '@video-compressor/shared';
import { runStitchPipeline, type StitchPipeline } from '../stitcher/pipeline.js';
import { detectStitching, screensFromEmbedding } from '../stitcher/plan.js';
import { probeSource } from '../stitcher/probe.js';
import { PreparedBodyCache } from '../stitcher/body-cache.js';
import type { TeamProcessDelegate, TeamProcessDelegateInput } from './process.js';

/** What the web sends with a re-stitched delivery. */
export interface RestitchDelegateOptions {
  defaults: TeamRestitchDefaults;
  /** What a previous inspection found, when there was one. */
  prepared: MaterialRestitchPrep | null;
}

export interface RestitchDelegateDeps {
  /** The compressor's image library, read live — the space stores ids, not pictures. */
  embedding: () => ImageEmbeddingSettings;
  imagePathFor: (id: string) => Promise<string | null>;
  bodies?: PreparedBodyCache;
  pipeline?: StitchPipeline;
  threads?: () => number | null;
}

/**
 * What the run found, when it had to look.
 *
 * Handed back so the caller can store it and nobody pays for the same inspection twice. The
 * delegate does not write it anywhere itself: the bridge has never talked to the cloud, and
 * this feature is not the reason to start.
 */
export interface RestitchDelegateDiscovery {
  /** Which detector found these edges, so a newer one is not held to an older one's answer. */
  detectorVersion: number;
  detectedStartSeconds: number;
  detectedEndSeconds: number;
  profile: SourceProfile;
}

export function parseRestitchOptions(value: unknown): RestitchDelegateOptions | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const defaults = parseTeamRestitchDefaults(record.defaults);
  if (!defaults.ok || !defaults.value.configured) return null;
  const prepared =
    record.prepared === undefined || record.prepared === null
      ? null
      : parseMaterialRestitchPrep(record.prepared);
  return {
    defaults: defaults.value,
    // An unreadable record is treated as absent: the run then looks for itself, which is
    // slower and always correct.
    prepared: prepared && prepared.ok ? prepared.value : null
  };
}

/**
 * The screens this space draws, from the images this machine actually has.
 *
 * The space records which ids may be drawn; the pictures live in the compressor's library. An
 * id the member's agent has never seen simply drops out of the draw — the alternative, failing
 * the whole delivery because one photo is elsewhere, would make the feature unusable across
 * two machines.
 */
export function spaceScreens(
  library: ImageEmbeddingSettings,
  defaults: TeamRestitchDefaults,
  random: () => number = Math.random
): StitchScreens {
  const keep = (assets: ImageEmbeddingSettings['startImages'], ids: readonly string[]) =>
    assets.filter(asset => ids.includes(asset.id));
  const wantsScreens = defaults.operation !== 'unstitch';
  return screensFromEmbedding(
    {
      ...library,
      startImages: keep(library.startImages, defaults.startImageIds),
      endImages: keep(library.endImages, defaults.endImageIds),
      // The space's lists are already the enabled set; a second exclusion list here would
      // silently subtract one member's local preferences from everyone else's space.
      disabledImageIds: [],
      startEnabled: wantsScreens,
      endEnabled: wantsScreens,
      fitMode: defaults.fitMode,
      finalDurationMode: defaults.finalDurationMode,
      customFinalDurationSeconds: defaults.customFinalDurationSeconds
    },
    {},
    random
  );
}

/**
 * The refusal, with its reason attached.
 *
 * `UNSUPPORTED_MEDIA` stays the code on the wire — it is what every caller already handles —
 * and the reason rides beside it so the row can say the true sentence instead of the generic
 * one. A refusal whose reason was lost (an old prepared record) simply carries none.
 */
/** A stored reason, narrowed to the five this product knows; anything else is dropped. */
function refusalReason(value: string | null): StitchUnsupportedReason | null {
  const known: readonly StitchUnsupportedReason[] = [
    'video-codec',
    'audio-codec',
    'variable-frame-rate',
    'container',
    'unreadable'
  ];
  return known.find(reason => reason === value) ?? null;
}

function unsupported(reason: StitchUnsupportedReason | null): Error {
  const error = new Error('UNSUPPORTED_MEDIA');
  return reason ? Object.assign(error, { reason }) : error;
}

export function createRestitchDelegate(
  deps: RestitchDelegateDeps
): TeamProcessDelegate & { lastDiscovery: () => RestitchDelegateDiscovery | null } {
  const bodies = deps.bodies ?? new PreparedBodyCache();
  const pipeline = deps.pipeline ?? runStitchPipeline;
  let discovery: RestitchDelegateDiscovery | null = null;

  const delegate = async (input: TeamProcessDelegateInput) => {
    discovery = null;
    const options = parseRestitchOptions(input.options);
    if (!options) throw new Error('INVALID_INPUT');

    // A delivery has no child to hold between its steps, so it says so rather than reporting
    // a pause it did not perform.
    input.pausable(null);

    const looked = await inspect(input.sourceFile, options.prepared, input.signal);
    if (!looked) throw unsupported(refusalReason(options.prepared?.unsupportedReason ?? null));
    if (!options.prepared) {
      discovery = {
        detectorVersion: RESTITCH_DETECTOR_VERSION,
        detectedStartSeconds: looked.detected.startSeconds,
        detectedEndSeconds: looked.detected.endSeconds,
        profile: looked.profile
      };
    }
    input.onProgress(40);

    const screens = spaceScreens(deps.embedding(), options.defaults);
    const planned = planStitch(
      looked.profile,
      looked.detected,
      screens,
      options.defaults.operation
    );
    if (!planned.ok) {
      // Each refusal keeps its own name, so the row can say the true sentence rather than a
      // generic one: "no photo chosen" and "nothing to remove" are different problems with
      // different fixes, and neither is "this file is unsupported".
      // Each refusal keeps its own code *and* its own reason: the code is what every caller
      // already handles, and the reason is what lets the row say which fix is the fix.
      if (planned.error === 'no-screens') {
        throw Object.assign(new Error('INVALID_INPUT'), { reason: 'no-screens' });
      }
      if (planned.error === 'nothing-to-remove') {
        throw Object.assign(new Error('WRONG_STATE'), { reason: 'nothing-to-remove' });
      }
      // Which of the five it is travels with the error: "this file type is not
      // supported" is the wrong sentence for a variable frame rate, and the
      // interface already has the right one for each.
      throw unsupported(planned.error);
    }

    const produced = await pipeline({
      request: {
        profile: looked.profile,
        plan: planned.value,
        screens,
        destination: { kind: 'beside' },
        outputSuffix: ''
      },
      workDir: input.workspace,
      threads: deps.threads?.() ?? null,
      signal: input.signal,
      onChild: () => {},
      /*
       * The three stages are the anchors; the join reports between them.
       *
       * Screens are rendered first (a second or two), the join is nearly the whole wait, and
       * verification closes it. Reporting only the anchors left the bar standing still at
       * one number for minutes, which reads as a hang rather than as work.
       */
      onStage: stage =>
        input.onProgress(stage === 'verifying' ? 92 : stage === 'joining' ? 45 : 42),
      onJoinProgress: fraction => input.onProgress(45 + Math.round(fraction * 45)),
      imagePathFor: deps.imagePathFor,
      bodies
    });
    if (!produced.ok) {
      throw new Error(
        produced.error === 'STITCH_CANCELLED' ? 'PROCESS_CANCELED' : 'PROCESS_FAILED'
      );
    }
    const output = await stat(produced.stagedPath);
    if (!output.isFile() || output.size < 1) throw new Error('INVALID_RESPONSE');
    input.onProgress(100);
    return {
      file: produced.stagedPath,
      mimeType: 'video/mp4',
      sizeBytes: output.size,
      ...(discovery ? { discovered: discovery } : {})
    };
  };

  return Object.assign(delegate, { lastDiscovery: () => discovery });
}

/**
 * The step a prepared space never takes.
 *
 * With a record in hand this is a no-op; without one it is the expensive half of the run — a
 * keyframe index and a search for what is already stitched on, measured at six to fourteen
 * seconds depending on the file's length.
 */
async function inspect(
  file: string,
  prepared: MaterialRestitchPrep | null,
  signal: AbortSignal
): Promise<{
  profile: SourceProfile;
  detected: { startSeconds: number; endSeconds: number; adjustedByUser: boolean };
} | null> {
  if (prepared) {
    // Either the record says the fast path cannot serve this file, or it carries no profile to
    // serve it with — both mean the same thing to a delivery.
    if (prepared.unsupportedReason || !prepared.profile) return null;
    return {
      // The path in a stored profile belongs to whichever machine prepared it; this run's copy
      // is somewhere else entirely.
      profile: { ...prepared.profile, path: file },
      detected: {
        startSeconds: prepared.detectedStartSeconds,
        endSeconds: prepared.detectedEndSeconds,
        adjustedByUser: false
      }
    };
  }
  const probed = await probeSource(file, { signal });
  if (!probed.ok) return null;
  const detected = await detectStitching(probed.value, signal);
  return { profile: probed.value, detected };
}
