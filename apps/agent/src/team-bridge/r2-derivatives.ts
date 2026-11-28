import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  BUILD_ID,
  SPACE_DERIVATIVE_SPRITE,
  SPACE_DERIVATIVE_VARIANTS,
  SPACE_STORAGE_CAPABILITY,
  SPACE_STORAGE_CAPABILITY_HEADER,
  isSpaceDerivativeVariant,
  parseSpaceDerivativeUrls,
  parseTeamTransferGrant,
  sniffSpaceDerivative,
  spaceDerivativeSlotsFor,
  type SpaceDerivativeDeclaration,
  type SpaceDerivativeVariant,
  type SpaceMediaFacts,
  type TeamTransferGrant
} from '@video-compressor/shared';
import { ffmpegPath, ffprobePath } from '../ffmpeg/tools.js';
import { decodePng, encodeWebp } from '../landing/webp.js';
import { activeGovernorOrNull, spawnManaged } from '../power/spawn.js';
import type { DownloadedTeamSource, TeamSourceDownloadRequest } from './transfer.js';

/**
 * 057 T047: the pictures of an R2 file the uploading browser could not make (research R5).
 *
 * A member's page hands this computer one job of its space: a lease, a ticket for the file and
 * what is already there. The agent reads the file through space-storage (re-verified by content
 * id, `r2-transfer.ts`), asks ffprobe what it is, makes with its own ffmpeg whatever the space
 * still lacks — the three explorer sizes, and for a video the poster and the hover frames — plus
 * the codec and frame rate the browser cannot tell, and stages them with the lease. The server
 * checks each picture as it checks the browser's. A format nothing here can read (a PDF: the
 * bundled ffmpeg has no PDF renderer) is answered `unsupported`, and the file says so (FR-012).
 *
 * Every ffmpeg goes through the power governor, one job at a time, so a folder of HEVC clips
 * never takes the machine away from the person in front of it. Paths are built with `path` and
 * never through a shell, so Windows and macOS run the same code.
 */

export interface SpaceDerivativeJobInput {
  teamId: string;
  objectId: string;
  contentId: string;
  contentType: string;
  category: string | null;
  bytes: number;
  made: SpaceDerivativeVariant[];
  needsMediaFacts: boolean;
  leaseToken: string;
  source: TeamTransferGrant;
}

export interface SpaceDerivativeRequest {
  job: SpaceDerivativeJobInput;
  transferUrl: string;
  cloudBaseUrl: string;
}

export interface SpaceDerivativeTransfer {
  downloadSource(
    request: TeamSourceDownloadRequest,
    signal: AbortSignal
  ): Promise<DownloadedTeamSource>;
}

/** The media tools, behind a seam the tests replace (no ffmpeg in CI). */
export interface SpaceDerivativeTools {
  /** ffprobe's JSON (`-show_streams -show_format`), unparsed. */
  probe(file: string, signal: AbortSignal): Promise<unknown>;
  /** One frame at `seconds` (images: the picture), fitted in `maxEdge`, as a PNG at `target`. */
  frame(
    input: { file: string; seconds: number | null; maxEdge: number; target: string },
    signal: AbortSignal
  ): Promise<boolean>;
  /** `frames` frames tiled `columns` wide, each fitted in `cellEdge`, as a PNG at `target`. */
  sprite(
    input: { file: string; durationSeconds: number; target: string },
    signal: AbortSignal
  ): Promise<boolean>;
  /** The PNG as WebP. */
  webp(png: string): Promise<Buffer>;
}

export interface SpaceDerivativeOutcome {
  state: string;
  accepted: SpaceDerivativeVariant[];
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
/** One second in, as the browser's poster. */
const POSTER_SECONDS = 1;

// ffprobe -----------------------------------------------------------------------------------

const finite = (value: unknown): number | null => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null;
};

function frameRate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,9})\/(\d{1,9})$/u.exec(value);
  if (!match) return finite(value);
  const den = Number(match[2]);
  return den > 0 ? finite(Number(match[1]) / den) : null;
}

/**
 * What ffprobe said, read as untrusted: only known fields, each within the server's bounds.
 * A stream without a picture, or anything malformed, gives nulls rather than a guess.
 */
export function parseFfprobeMedia(value: unknown): SpaceMediaFacts & { hasPicture: boolean } {
  const empty = {
    durationMs: null,
    width: null,
    height: null,
    codec: null,
    fps: null,
    hasPicture: false
  };
  if (!value || typeof value !== 'object') return empty;
  const record = value as { streams?: unknown; format?: unknown };
  const streams = Array.isArray(record.streams) ? record.streams : [];
  const video = streams.find(
    (stream): stream is Record<string, unknown> =>
      !!stream &&
      typeof stream === 'object' &&
      (stream as { codec_type?: unknown }).codec_type === 'video'
  );
  if (!video) return empty;
  const format =
    record.format && typeof record.format === 'object'
      ? (record.format as Record<string, unknown>)
      : {};
  const dimension = (item: unknown) => {
    const number = finite(item);
    return number !== null && Number.isInteger(number) && number <= 65_535 ? number : null;
  };
  const rotation = (() => {
    const sides = Array.isArray(video.side_data_list) ? video.side_data_list : [];
    const side = sides.find(item => item && typeof item === 'object' && 'rotation' in item) as
      { rotation?: unknown } | undefined;
    const tags =
      video.tags && typeof video.tags === 'object' ? (video.tags as { rotate?: unknown }) : {};
    const raw = Number(side?.rotation ?? tags.rotate ?? 0);
    return Number.isFinite(raw) ? ((Math.round(raw) % 360) + 360) % 360 : 0;
  })();
  let width = dimension(video.width);
  let height = dimension(video.height);
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const seconds = finite(video.duration) ?? finite(format.duration);
  const durationMs = seconds === null ? null : Math.round(seconds * 1000);
  const codec =
    typeof video.codec_name === 'string' &&
    /^[a-z0-9._-]{1,32}$/u.test(video.codec_name.toLowerCase())
      ? video.codec_name.toLowerCase()
      : null;
  const fps = frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate);
  const still =
    codec !== null &&
    ['mjpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'heic', 'hevc_image'].includes(codec);
  return {
    durationMs: durationMs !== null && durationMs <= 7 * 24 * 3600 * 1000 ? durationMs : null,
    width,
    height,
    codec,
    fps: still || fps === null || fps > 1000 ? null : Math.round(fps * 1000) / 1000,
    hasPicture: width !== null && height !== null
  };
}

/** What this job still needs, by the space's own slots for the file. */
export function variantsToMake(
  job: Pick<SpaceDerivativeJobInput, 'category' | 'made'>
): SpaceDerivativeVariant[] {
  return spaceDerivativeSlotsFor(job.category).filter(variant => !job.made.includes(variant));
}

// The bridge ----------------------------------------------------------------------------------

export class SpaceDerivativeBridge {
  readonly #transfer: SpaceDerivativeTransfer;
  readonly #tools: SpaceDerivativeTools;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #active: AbortController | null = null;

  constructor(options: {
    transfer: SpaceDerivativeTransfer;
    tools?: SpaceDerivativeTools;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.#transfer = options.transfer;
    this.#tools = options.tools ?? ffmpegDerivativeTools;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  busy(): boolean {
    return this.#active !== null;
  }

  async shutdown(): Promise<void> {
    this.#active?.abort(new Error('DERIVATIVE_CANCELED'));
    this.#active = null;
  }

  async run(request: SpaceDerivativeRequest): Promise<SpaceDerivativeOutcome> {
    if (this.#active) throw new Error('WRONG_STATE');
    const controller = new AbortController();
    this.#active = controller;
    const deadline = setTimeout(
      () => controller.abort(new Error('DERIVATIVE_TIMEOUT')),
      activeGovernorOrNull()?.scaleTimeout(this.#timeoutMs) ?? this.#timeoutMs
    );
    deadline.unref();
    const { job } = request;
    let downloaded: DownloadedTeamSource | null = null;
    try {
      // No PDF renderer ships with Soty: the first page is not made here, and the file says so.
      if (job.contentType === 'application/pdf')
        return await this.#finish(
          request,
          { outcome: 'unsupported', errorCode: 'UNSUPPORTED_FORMAT' },
          controller.signal
        );
      const wanted = variantsToMake(job);
      if (wanted.length === 0 && !job.needsMediaFacts)
        return await this.#finish(
          request,
          { outcome: 'ready', derivatives: [], media: null },
          controller.signal
        );
      try {
        downloaded = await this.#transfer.downloadSource(
          {
            operationId: `derivative:${job.objectId}`,
            transferUrl: request.transferUrl,
            grant: job.source
          },
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        return await this.#finish(
          request,
          { outcome: 'failed', errorCode: 'SOURCE_UNAVAILABLE' },
          controller.signal
        );
      }
      const media = parseFfprobeMedia(
        await this.#tools.probe(downloaded.file, controller.signal).catch(() => null)
      );
      if (!media.hasPicture)
        return await this.#finish(
          request,
          { outcome: 'unsupported', errorCode: 'UNSUPPORTED_FORMAT' },
          controller.signal
        );
      const made = await this.#make(downloaded, media, wanted, controller.signal);
      if (wanted.length > 0 && made.length === 0)
        return await this.#finish(
          request,
          { outcome: 'unsupported', errorCode: 'UNSUPPORTED_FORMAT' },
          controller.signal
        );
      const facts: SpaceMediaFacts = {
        durationMs: media.durationMs,
        width: media.width,
        height: media.height,
        codec: media.codec,
        fps: media.fps
      };
      return await this.#finish(
        request,
        { outcome: 'ready', derivatives: made, media: facts },
        controller.signal
      );
    } finally {
      clearTimeout(deadline);
      if (this.#active === controller) this.#active = null;
      await downloaded?.cleanup().catch(() => undefined);
    }
  }

  async #make(
    source: DownloadedTeamSource,
    media: ReturnType<typeof parseFfprobeMedia>,
    wanted: readonly SpaceDerivativeVariant[],
    signal: AbortSignal
  ): Promise<Array<SpaceDerivativeDeclaration & { bytes: number; body: Buffer }>> {
    const video = media.durationMs !== null && media.fps !== null;
    const seconds = video ? Math.min(POSTER_SECONDS, (media.durationMs ?? 0) / 2000) : null;
    const out: Array<SpaceDerivativeDeclaration & { bytes: number; body: Buffer }> = [];
    for (const variant of wanted) {
      if (signal.aborted) throw signal.reason ?? new Error('DERIVATIVE_CANCELED');
      const target = path.join(source.workspace, `derivative-${variant}.png`);
      const limit = SPACE_DERIVATIVE_VARIANTS[variant];
      try {
        const ok =
          variant === 'sprite'
            ? video && media.durationMs !== null
              ? await this.#tools.sprite(
                  { file: source.file, durationSeconds: media.durationMs / 1000, target },
                  signal
                )
              : false
            : await this.#tools.frame(
                {
                  file: source.file,
                  seconds,
                  maxEdge: Math.min(limit.maxWidth, limit.maxHeight),
                  target
                },
                signal
              );
        if (!ok) continue;
        const body = await this.#tools.webp(target);
        const sniffed = sniffSpaceDerivative(
          new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
        );
        if (
          !sniffed ||
          body.byteLength < 1 ||
          body.byteLength > limit.maxBytes ||
          sniffed.width > limit.maxWidth ||
          sniffed.height > limit.maxHeight
        )
          continue;
        out.push({
          variant,
          contentType: sniffed.contentType,
          bytes: body.byteLength,
          width: sniffed.width,
          height: sniffed.height,
          md5: createHash('md5').update(body).digest('hex'),
          body
        });
      } finally {
        await rm(target, { force: true }).catch(() => undefined);
      }
    }
    return out;
  }

  async #edge(base: string, route: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.#fetch(`${base.replace(/\/$/u, '')}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SPACE_STORAGE_CAPABILITY_HEADER]: SPACE_STORAGE_CAPABILITY,
        'x-soty-client': `agent/${BUILD_ID}`
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        payload && typeof payload === 'object' && 'error' in payload
          ? (payload as { error?: { code?: unknown } }).error?.code
          : null;
      throw new Error(typeof code === 'string' ? code : 'STORAGE_UNAVAILABLE');
    }
    return payload;
  }

  async #finish(
    request: SpaceDerivativeRequest,
    result:
      | {
          outcome: 'ready';
          derivatives: Array<SpaceDerivativeDeclaration & { body: Buffer }>;
          media: SpaceMediaFacts | null;
        }
      | { outcome: 'unsupported' | 'failed'; errorCode: string },
    signal: AbortSignal
  ): Promise<SpaceDerivativeOutcome> {
    const { job } = request;
    const lease = { teamId: job.teamId, objectId: job.objectId, leaseToken: job.leaseToken };
    let declared: SpaceDerivativeDeclaration[] = [];
    if (result.outcome === 'ready' && result.derivatives.length > 0) {
      declared = result.derivatives.map(({ body: _body, ...item }) => item);
      const staged = parseSpaceDerivativeUrls(
        await this.#edge(
          request.cloudBaseUrl,
          '/agent/derivatives/stage',
          { ...lease, derivatives: declared },
          signal
        )
      );
      if (!staged.ok) throw new Error('INVALID_RESPONSE');
      for (const target of staged.value) {
        const picture = result.derivatives.find(item => item.variant === target.variant);
        if (!picture) continue;
        const response = await this.#fetch(target.url, {
          method: 'PUT',
          headers: { 'Content-MD5': target.contentMd5, 'Content-Type': target.contentType },
          body: new Uint8Array(picture.body),
          redirect: 'error',
          signal
        });
        await response.body?.cancel().catch(() => undefined);
        // A refused PUT leaves the picture out; the server sees it missing and says so.
      }
    }
    const value = await this.#edge(
      request.cloudBaseUrl,
      '/agent/derivatives/finish',
      result.outcome === 'ready'
        ? {
            ...lease,
            outcome: 'ready',
            derivatives: declared,
            ...(result.media ? { media: result.media } : {})
          }
        : { ...lease, outcome: result.outcome, errorCode: result.errorCode },
      signal
    );
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return {
      state: typeof record.state === 'string' ? record.state : 'unknown',
      accepted: Array.isArray(record.accepted)
        ? record.accepted.filter(isSpaceDerivativeVariant)
        : []
    };
  }
}

/** The request as the page sends it, or null. Nothing else is read from it. */
export function spaceDerivativeRequest(value: unknown): SpaceDerivativeRequest | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const job =
    body.job && typeof body.job === 'object' ? (body.job as Record<string, unknown>) : null;
  const uuid = (item: unknown): item is string =>
    typeof item === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item);
  const source = job ? parseTeamTransferGrant(job.source) : null;
  const bytes =
    job && typeof job.bytes === 'string' && /^\d{1,15}$/u.test(job.bytes)
      ? Number(job.bytes)
      : null;
  if (
    !job ||
    !uuid(job.teamId) ||
    !uuid(job.objectId) ||
    typeof job.contentId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(job.contentId) ||
    typeof job.contentType !== 'string' ||
    (job.category !== null && typeof job.category !== 'string') ||
    bytes === null ||
    !Array.isArray(job.made) ||
    !job.made.every(isSpaceDerivativeVariant) ||
    typeof job.needsMediaFacts !== 'boolean' ||
    typeof job.leaseToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(job.leaseToken) ||
    source?.purpose !== 'download_range' ||
    typeof body.transferUrl !== 'string' ||
    typeof body.cloudBaseUrl !== 'string' ||
    !/^https?:\/\//u.test(body.cloudBaseUrl)
  )
    return null;
  return {
    job: {
      teamId: job.teamId,
      objectId: job.objectId,
      contentId: job.contentId,
      contentType: job.contentType,
      category: job.category as string | null,
      bytes,
      made: [...job.made],
      needsMediaFacts: job.needsMediaFacts,
      leaseToken: job.leaseToken,
      source
    },
    transferUrl: body.transferUrl,
    cloudBaseUrl: body.cloudBaseUrl
  };
}

// The bundled ffmpeg ----------------------------------------------------------------------------

function runTool(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  collect = false
): Promise<{ code: number | null; stdout: string }> {
  const child = spawnManaged(activeGovernorOrNull(), command, args, {
    toolId: 'space-derivatives'
  });
  let stdout = '';
  if (collect)
    child.stdout.on('data', chunk => (stdout = (stdout + chunk.toString()).slice(-1_000_000)));
  else child.stdout.resume();
  child.stderr.resume();
  const abort = () => child.kill('SIGTERM');
  signal.addEventListener('abort', abort, { once: true });
  return new Promise(resolve => {
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      resolve({ code, stdout });
    });
    child.once('error', () => {
      signal.removeEventListener('abort', abort);
      resolve({ code: null, stdout });
    });
  });
}

const scale = (edge: number) =>
  `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease`;

export const ffmpegDerivativeTools: SpaceDerivativeTools = {
  async probe(file, signal) {
    const result = await runTool(
      ffprobePath,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      signal,
      true
    );
    if (result.code !== 0) return null;
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      return null;
    }
  },
  async frame({ file, seconds, maxEdge, target }, signal) {
    const result = await runTool(
      ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        ...(seconds !== null ? ['-ss', String(seconds)] : []),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        scale(maxEdge),
        '-pix_fmt',
        'rgba',
        '-c:v',
        'png',
        '-y',
        target
      ],
      signal
    );
    if (signal.aborted) throw signal.reason ?? new Error('DERIVATIVE_CANCELED');
    return result.code === 0;
  },
  async sprite({ file, durationSeconds, target }, signal) {
    const { frames, columns, frameMaxEdge } = SPACE_DERIVATIVE_SPRITE;
    const rows = Math.ceil(frames / columns);
    const rate = Math.max(frames / Math.max(durationSeconds, 0.1), 0.001);
    const result = await runTool(
      ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        file,
        '-vf',
        `fps=${rate.toFixed(6)},${scale(frameMaxEdge)},tile=${columns}x${rows}`,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgba',
        '-c:v',
        'png',
        '-y',
        target
      ],
      signal
    );
    if (signal.aborted) throw signal.reason ?? new Error('DERIVATIVE_CANCELED');
    return result.code === 0;
  },
  async webp(png) {
    return encodeWebp(await decodePng(await readFile(png)), 'optimal');
  }
};
