/**
 * Soty's standard re-stitch pictures, carried inside the agent (071).
 *
 * The effective re-stitch settings mark a slot `builtin` when the person left it on and has no
 * picture of their own (migration 20261224170000). The pictures themselves are the web's
 * immutable static files `/restitch/soty-restitch-{start,end}.v1.png`; the agent carries the
 * same bytes here rather than fetching them, for three reasons:
 *
 * - **Nothing to reach.** A background catalog round runs with no page open, possibly with the
 *   web host down or cached wrongly (a CDN once served index.html for a missing chunk); a
 *   picture that must be downloaded is one more way a video fails at 3 a.m.
 * - **Nothing to package.** Two PNGs of under 3 KB each as base64 in a module ship through the
 *   compiler on every platform, with no installer, resource path or signing step to forget —
 *   the ffmpeg-style `runtime/bin` route needs a copy step in each platform's packaging.
 * - **Proved, not trusted.** Each picture is checked against the sha256 in
 *   `RESTITCH_BUILTIN_SCREENS` before it is written; a mismatch (a build that edited one side
 *   only) refuses the job instead of stitching a picture nobody chose. A test compares these
 *   bytes with the web's files.
 *
 * A new design is a new version (`v2` files, a new `version` in the contract); an agent that
 * meets a version it does not carry keeps the compatibility fields the server wrote for it.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RESTITCH_BUILTIN_SCREENS, type TeamRestitchDefaults } from '@video-compressor/shared';

/** The only picture version this build carries. */
export const BUILTIN_SCREENS_VERSION = 1 as const;

const BYTES_BASE64 = {
  start:
    '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',
  end:
    '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'
} as const;

export type BuiltinSlot = 'start' | 'end';

/** The id the stitcher sees for a standard picture; never a library or cache id. */
export function builtinScreenId(slot: BuiltinSlot): string {
  return `soty-builtin-${slot}-v${BUILTIN_SCREENS_VERSION}`;
}

/** The picture's bytes, proved against the shared contract. */
export function builtinScreenBytes(slot: BuiltinSlot): Buffer {
  const bytes = Buffer.from(BYTES_BASE64[slot], 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (
    RESTITCH_BUILTIN_SCREENS.version !== BUILTIN_SCREENS_VERSION ||
    digest !== RESTITCH_BUILTIN_SCREENS[slot].sha256
  )
    throw new Error('RESTITCH_SCREEN_UNAVAILABLE');
  return bytes;
}

/**
 * Which slots this agent fills with a standard picture.
 *
 * Only for the version it carries: a newer contract keeps the compatibility fields, which every
 * agent renders. `unstitch` has no screens at all.
 */
export function builtinSlotsFor(defaults: TeamRestitchDefaults): { start: boolean; end: boolean } {
  const builtin = defaults.builtin;
  if (!builtin || builtin.version !== BUILTIN_SCREENS_VERSION || defaults.operation === 'unstitch')
    return { start: false, end: false };
  return { start: builtin.start === true, end: builtin.end === true };
}

/**
 * The settings as the person meant them, for an agent that has the pictures.
 *
 * The server rewrote a standard start to `startEnabled: false` and a standard end to
 * `automaticEndFrame: true` or `endEnabled: false`. With `builtin` those rewrites are reversible
 * exactly: the slot was enabled, and the end screen is the standard picture, not the video's own
 * last frame.
 */
export function withBuiltinSlots(defaults: TeamRestitchDefaults): TeamRestitchDefaults {
  const slots = builtinSlotsFor(defaults);
  if (!slots.start && !slots.end) return defaults;
  const next: TeamRestitchDefaults = { ...defaults };
  if (slots.start) next.startEnabled = true;
  if (slots.end) {
    next.endEnabled = true;
    delete next.automaticEndFrame;
  }
  return next;
}

/** Writes the picture into the job's own workspace and returns its path. */
export async function writeBuiltinScreen(workspace: string, slot: BuiltinSlot): Promise<string> {
  const file = path.join(workspace, `${builtinScreenId(slot)}.png`);
  await writeFile(file, builtinScreenBytes(slot), { mode: 0o600 });
  return file;
}
