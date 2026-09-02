/**
 * The stitcher's HTTP surface.
 *
 * Every reply is either the tool's state snapshot or `{ error }` with a stable machine code,
 * the way every other tool answers. The one route that is not about a job — `inspect` — is
 * what makes the interface able to show, before anything runs, exactly what will happen.
 */

import path from 'node:path';

/** The compressor's own ceiling; the body is drained, never stored. */
const MAX_MEDIA_UPLOAD_BYTES = 100 * 1024 * 1024 * 1024;
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import {
  parseStitchSettingsPatch,
  stitchUnsupportedReason,
  type ImageEmbeddingSettings,
  type SourceProfile,
  type StitchJob,
  type StitchOperation,
  type StitchScreens
} from '@video-compressor/shared';
import { hasCapability } from '../server/capabilities.js';
import { pathGrants } from '../files/path-grants.js';
import { findDroppedSource } from '../files/dropped-source.js';
import { selectOutputFolder, selectVideos } from '../files/picker.js';
import { uploadIntakeMeta } from '../files/upload-intake.js';
import { showInFileManager } from '../platform/platform.js';
import { inspectSource, screensFromEmbedding, type InspectionFailure } from './plan.js';
import { probeSource } from './probe.js';
import type { StitchQueue } from './queue.js';

export interface StitcherContext {
  queue: StitchQueue;
  events: { handler: RouteHandlerMethod };
  acceptingNewTasks: () => boolean;
  tools: () => { ffmpeg: boolean; ffprobe: boolean };
  /** The compressor's live screen settings: one library, one set of controls. */
  embedding: () => ImageEmbeddingSettings;
}

interface JobBody {
  path?: unknown;
  startImageId?: unknown;
  endImageId?: unknown;
  operation?: unknown;
  boundaries?: unknown;
  destination?: unknown;
  outputSuffix?: unknown;
  endDurationSeconds?: unknown;
}

export function registerStitcherRoutes(app: FastifyInstance, ctx: StitcherContext): void {
  const { queue } = ctx;

  app.get('/api/stitcher', async () => ({ state: queue.state() }));

  app.get('/api/stitcher/events', ctx.events.handler);

  /**
   * Choosing a video through the host's own file dialog.
   *
   * The stitcher needs the real path, not a copy: "beside the original" and "overwrite the
   * original" both mean the file the user is looking at. So it picks rather than uploads,
   * and the chosen paths are granted as they are chosen.
   */
  app.post('/api/stitcher/select', async (_request, reply) => {
    if (!hasCapability('native-file-picker'))
      return reply.code(501).send({ error: 'NATIVE_FILE_PICKER_UNSUPPORTED' });
    const paths = await selectVideos();
    for (const candidate of paths) pathGrants.mint(candidate, { origin: 'picker' });
    return { paths };
  });

  /**
   * A video dropped from the file manager.
   *
   * Chrome hands a Finder drop the file's **contents**, not its path, so a dropped video
   * arrives as an upload. The stitcher cannot work on a copy — "beside the original" and
   * "overwrite the original" both mean the file the user is looking at — so the upload is
   * drained without being written anywhere and the real file is found on disk from its name,
   * size and modification time, exactly as the compressor does it.
   */
  app.post('/api/stitcher/dropped', async (request, reply) => {
    const part = await request.file({ limits: { fileSize: MAX_MEDIA_UPLOAD_BYTES } });
    if (!part) return reply.code(400).send({ error: 'STITCH_PATH_INVALID' });
    const { fileName, sourceSize, sourceModifiedAt } = uploadIntakeMeta(part, 'video.mp4');
    /* Always drain: an abandoned multipart stream wedges the connection. There is nothing to
       drain in practice — the client sends an empty part, because this route matches a file by
       its name, size and modification time and never reads a byte of it. */
    part.file.resume();
    const found = await findDroppedSource(fileName, sourceSize, sourceModifiedAt);
    if (!found) return reply.code(404).send({ error: 'STITCH_DROPPED_NOT_FOUND' });
    pathGrants.mint(found, { origin: 'drop' });
    return { paths: [found] };
  });

  /** The destination folder, chosen the same way the compressor chooses its own. */
  app.post('/api/stitcher/select-folder', async (_request, reply) => {
    if (!hasCapability('native-file-picker'))
      return reply.code(501).send({ error: 'NATIVE_FILE_PICKER_UNSUPPORTED' });
    const folder = await selectOutputFolder();
    if (folder) pathGrants.mint(folder, { origin: 'picker' });
    return { path: folder };
  });

  app.post<{ Body: JobBody }>(
    '/api/stitcher/inspect',
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const source = localPath(request.body?.path);
      if (!source) return reply.code(400).send({ error: 'STITCH_PATH_INVALID' });
      if (!grant(source)) return reply.code(403).send({ error: 'PATH_NOT_GRANTED' });
      if (!ctx.tools().ffprobe) return reply.code(503).send({ error: 'MEDIA_TOOL_UNAVAILABLE' });

      const inspection = await inspectSource({
        path: source,
        screens: screensFor(request.body, ctx),
        operation: operationOf(request.body?.operation),
        boundaries: boundariesOf(request.body?.boundaries)
      });
      if (!inspection.ok) return sendFailure(reply, inspection.error);
      return {
        profile: inspection.value.profile,
        detected: inspection.value.detected,
        plan: inspection.value.plan
      };
    }
  );

  /**
   * Put files in the list. Nothing runs — the compressor's `add`.
   *
   * Each is probed and its edges are found once, here, so the row can show what the file is
   * and starting it later needs no second look.
   */
  app.post<{ Body: { paths?: unknown } }>(
    '/api/stitcher/files',
    { bodyLimit: 256 * 1024 },
    async (request, reply) => {
      const paths = Array.isArray(request.body?.paths) ? request.body.paths : [];
      const local = paths.map(localPath).filter((value): value is string => value !== null);
      if (!local.length) return reply.code(400).send({ error: 'STITCH_PATH_INVALID' });
      if (local.some(candidate => !grant(candidate)))
        return reply.code(403).send({ error: 'PATH_NOT_GRANTED' });
      if (!ctx.tools().ffprobe) return reply.code(503).send({ error: 'MEDIA_TOOL_UNAVAILABLE' });

      /*
       * One cheap probe each, and nothing else.
       *
       * Enough for the row's own figures and to refuse a file the fast path cannot serve.
       * The keyframe index and the search for screens already on the file cost seconds on a
       * long video and belong to the run that needs them — a dropped file appears in the list
       * at once (FR-030).
       */
      const candidates = [];
      const refused: { path: string; reason: string }[] = [];
      for (const candidate of local) {
        const probed = await probeSource(candidate, { keyframes: false });
        if (!probed.ok) {
          refused.push({ path: candidate, reason: 'unreadable' });
          continue;
        }
        const unsupported = stitchUnsupportedReason(probed.value);
        if (unsupported) {
          refused.push({ path: candidate, reason: unsupported });
          continue;
        }
        candidates.push({ profile: probed.value });
      }
      queue.add(candidates);
      return { state: queue.state(), refused };
    }
  );

  /**
   * Start the chosen rows — the compressor's "compress selected".
   *
   * The photos are frozen here rather than when the file was added, so a setting changed in
   * between is the setting that runs, and a random screen length is drawn once per row. What
   * the source already carries is found by the run itself — see the queue's inspecting stage.
   */
  app.post<{ Body: { ids?: unknown; operation?: unknown } }>(
    '/api/stitcher/start',
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      if (!ctx.acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
      if (!ctx.tools().ffmpeg || !ctx.tools().ffprobe)
        return reply.code(503).send({ error: 'MEDIA_TOOL_UNAVAILABLE' });
      const ids = Array.isArray(request.body?.ids)
        ? request.body.ids.filter((value): value is string => typeof value === 'string')
        : [];
      if (!ids.length) return reply.code(400).send({ error: 'STITCH_NOTHING_SELECTED' });
      const operation = operationOf(request.body?.operation) ?? 'restitch';

      const settings = queue.currentSettings();
      const failures: { id: string; error: string }[] = [];
      for (const id of ids) {
        const job = queue.state().jobs.find(candidate => candidate.id === id);
        if (!job) {
          failures.push({ id, error: 'STITCH_JOB_UNKNOWN' });
          continue;
        }
        /* The profile is remembered while the row is in the list, and the list outlives the
           process: rows are persisted, the profiles behind them are not. A row whose profile
           is gone starts with none and the run probes for itself, rather than refusing. */
        const screens = screensFromEmbedding(ctx.embedding());
        // The one refusal that needs nothing from the file, so it is answered at once.
        if (!screens.startImageId && !screens.endImageId && operation !== 'unstitch') {
          failures.push({ id, error: 'no-screens' });
          continue;
        }
        queue.start(id, {
          profile: queue.profileOf(id) ?? placeholderProfile(job),
          detected: job.detected,
          screens,
          operation,
          destination: settings.destination,
          outputSuffix: settings.outputSuffix
        });
      }
      return reply.code(202).send({ state: queue.state(), failures });
    }
  );

  /** Re-run the same source: a fresh draw from the library, a new file beside the last. */
  app.post<{ Params: { id: string } }>('/api/stitcher/jobs/:id/repeat', async (request, reply) => {
    if (!ctx.acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    const job = queue.state().jobs.find(candidate => candidate.id === request.params.id);
    if (!job) return reply.code(404).send({ error: 'STITCH_JOB_UNKNOWN' });
    if (!grant(job.sourcePath)) return reply.code(403).send({ error: 'PATH_NOT_GRANTED' });

    // A repeat keeps what the first run found, so it costs the search only once.
    const screens = screensFromEmbedding(ctx.embedding());
    queue.start(job.id, {
      profile: queue.profileOf(job.id) ?? placeholderProfile(job),
      detected: job.detected,
      screens,
      operation: job.operation,
      destination: job.destination,
      outputSuffix: job.outputSuffix
    });
    return reply.code(202).send({ state: queue.state() });
  });

  /** Drop one finished row, or every finished row — the compressor's two verbs. */
  app.delete<{ Params: { id: string } }>('/api/stitcher/jobs/:id', async (request, reply) => {
    if (!queue.remove(request.params.id))
      return reply.code(409).send({ error: 'STITCH_JOB_RUNNING' });
    return { state: queue.state() };
  });

  app.delete('/api/stitcher/jobs/completed', async () => {
    queue.clearSettled();
    return { state: queue.state() };
  });

  /** Show the finished file where it landed, or the source before there is one. */
  app.post<{ Params: { id: string } }>('/api/stitcher/jobs/:id/reveal', async (request, reply) => {
    const job = queue.state().jobs.find(candidate => candidate.id === request.params.id);
    if (!job) return reply.code(404).send({ error: 'STITCH_JOB_UNKNOWN' });
    showInFileManager(job.outputPath ?? job.sourcePath, { reveal: true });
    return { state: queue.state() };
  });

  app.post<{ Params: { id: string } }>('/api/stitcher/jobs/:id/open', async (request, reply) => {
    const job = queue.state().jobs.find(candidate => candidate.id === request.params.id);
    if (!job) return reply.code(404).send({ error: 'STITCH_JOB_UNKNOWN' });
    showInFileManager(job.outputPath ?? job.sourcePath);
    return { state: queue.state() };
  });

  app.post<{ Params: { id: string } }>('/api/stitcher/jobs/:id/cancel', async (request, reply) => {
    const stopped = await queue.cancel(request.params.id);
    if (stopped) return { state: queue.state() };
    const known = queue.state().jobs.some(job => job.id === request.params.id);
    return known
      ? reply.code(409).send({ error: 'STITCH_JOB_FINISHED' })
      : reply.code(404).send({ error: 'STITCH_JOB_UNKNOWN' });
  });

  // POST, not PATCH: the agent's CORS allows GET, POST, DELETE and OPTIONS, so a PATCH
  // never survives its preflight — it fails silently in the browser, which is exactly how
  // every settings click on this page did nothing at all.
  app.post<{ Body: unknown }>(
    '/api/stitcher/settings',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const patch = parseStitchSettingsPatch(request.body);
      if (!patch.ok) return reply.code(400).send({ error: patch.error });
      queue.updateSettings(patch.value);
      return { state: queue.state() };
    }
  );
}

/** 415 for a file this tool cannot serve, 409 for a request that asks for nothing. */
function sendFailure(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  failure: InspectionFailure
) {
  if (failure.kind === 'probe')
    return failure.error === 'tool-unavailable'
      ? reply.code(503).send({ error: 'MEDIA_TOOL_UNAVAILABLE' })
      : reply.code(415).send({ error: 'STITCH_SOURCE_UNSUPPORTED', reason: 'unreadable' });
  if (failure.error === 'nothing-to-remove')
    return reply.code(409).send({ error: 'STITCH_NOTHING_TO_REMOVE' });
  if (failure.error === 'no-screens')
    return reply.code(400).send({ error: 'STITCH_NO_SCREENS_CHOSEN' });
  return reply.code(415).send({ error: 'STITCH_SOURCE_UNSUPPORTED', reason: failure.error });
}

function localPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4_096 || value.includes('\0'))
    return null;
  return path.isAbsolute(value) ? path.resolve(value) : null;
}

/**
 * A path arriving here is a file the user chose, so it mints its own grant — through the
 * ledger, which is what applies the outer bound. Anything the ledger will not grant is
 * refused with one code whatever the cause, so the route cannot be used to ask whether a
 * given path exists.
 */
function grant(candidate: string): boolean {
  if (pathGrants.mint(candidate, { origin: 'drop' })) return true;
  return pathGrants.check(candidate, 'read');
}

/**
 * The screens a request describes, drawn from the compressor's library.
 *
 * `endDurationSeconds` is accepted from the caller because a random duration must be drawn
 * **once**: the interface asks for a preview, is told the result will be 43 minutes long, and
 * then starts the run — and if the run drew again, the number it was shown would have been a
 * guess about a different file. The preview draws it; the run repeats it.
 *
 * An image id is a **pin**, not a filter: omitted, the slot draws at random from the enabled
 * images exactly as the compressor does; `null` means the user asked for no screen there.
 */
function screensFor(body: JobBody | undefined, ctx: StitcherContext): StitchScreens {
  const chosen = Number(body?.endDurationSeconds);
  return screensFromEmbedding(ctx.embedding(), {
    startImageId: 'startImageId' in (body ?? {}) ? pinned(body?.startImageId) : undefined,
    endImageId: 'endImageId' in (body ?? {}) ? pinned(body?.endImageId) : undefined,
    endDurationSeconds: Number.isFinite(chosen) && chosen > 0 ? chosen : null
  });
}

function pinned(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function operationOf(value: unknown): StitchOperation | undefined {
  return value === 'stitch' || value === 'restitch' || value === 'unstitch' ? value : undefined;
}

function boundariesOf(value: unknown): { startSeconds: number; endSeconds: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const start = Number(record.startSeconds);
  const end = Number(record.endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) return undefined;
  return { startSeconds: start, endSeconds: end };
}

/**
 * A row whose profile the process no longer holds — every row, after a restart.
 *
 * Only the path matters: the queue's inspecting stage sees no keyframes and probes the file
 * itself. The figures come from what the row already shows, so nothing is invented.
 */
function placeholderProfile(job: StitchJob): SourceProfile {
  return {
    path: job.sourcePath,
    sizeBytes: job.source.sizeBytes,
    modifiedAtMs: 0,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: job.source.codec || 'h264',
    profile: null,
    level: null,
    width: job.source.width,
    height: job.source.height,
    pixelFormat: 'yuv420p',
    colorRange: 'unknown',
    frameRate: job.source.frameRate,
    variableFrameRate: false,
    videoTimescale: 15360,
    durationSeconds: job.source.durationSeconds,
    hasAudio: true,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 96,
    keyframeTimes: []
  };
}
