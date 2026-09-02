import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { TeamTransferGrant } from '@video-compressor/shared';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { encodeImageToWebp } from '../landing/images.js';
import { spawnManaged, activeGovernorOrNull } from '../power/spawn.js';
import type { DownloadedTeamSource, TeamSourceDownloadRequest } from './transfer.js';

/**
 * A poster frame for a video Google Drive never made a thumbnail for.
 *
 * Drive decides on its own whether a file gets a picture, and for plenty of
 * them the answer is never — the tile then shows a glyph and the person has to
 * open the file to find out what it is. The machine that can answer that is the
 * one already paired: it has ffmpeg, it can read the file through the grant it
 * would use for any other work, and one frame costs a second.
 *
 * The image is handed back to the cloud rather than written anywhere local: it
 * belongs to the space, and the same cache the provider's thumbnails live in is
 * what every surface already reads.
 */
export interface TeamPosterRequest {
  materialId: string;
  transferUrl: string;
  cloudBaseUrl: string;
  grant: TeamTransferGrant;
}

export interface TeamPosterTransfer {
  downloadSource(
    request: TeamSourceDownloadRequest,
    signal: AbortSignal
  ): Promise<DownloadedTeamSource>;
}

export interface TeamPosterBridgeOptions {
  transfer: TeamPosterTransfer;
  fetchImpl?: typeof fetch;
  /** Longest a single poster may take before it is abandoned. */
  timeoutMs?: number;
}

/** 320 px on the long side: what the tile shows, and nothing more to store. */
const POSTER_MAX_EDGE = 320;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** One second in, so a fade from black is not what the folder shows. */
const POSTER_SEEK_SECONDS = 1;

export class TeamPosterBridge {
  readonly #transfer: TeamPosterTransfer;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #active = new Map<string, AbortController>();

  constructor(options: TeamPosterBridgeOptions) {
    this.#transfer = options.transfer;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  busy(): boolean {
    return this.#active.size > 0;
  }

  async shutdown(): Promise<void> {
    for (const controller of this.#active.values()) {
      controller.abort(new Error('POSTER_CANCELED'));
    }
    this.#active.clear();
  }

  /** Downloads the video, takes one frame, and hands the picture to the cloud. */
  async render(request: TeamPosterRequest): Promise<{ stored: true }> {
    validate(request);
    if (this.#active.has(request.materialId)) throw new Error('WRONG_STATE');
    const controller = new AbortController();
    this.#active.set(request.materialId, controller);
    const deadline = setTimeout(
      () => controller.abort(new Error('POSTER_TIMEOUT')),
      activeGovernorOrNull()?.scaleTimeout(this.#timeoutMs) ?? this.#timeoutMs
    );
    deadline.unref();
    let downloaded: DownloadedTeamSource | null = null;
    try {
      downloaded = await this.#transfer.downloadSource(
        {
          operationId: `poster:${request.materialId}`,
          transferUrl: request.transferUrl,
          grant: request.grant
        },
        controller.signal
      );
      const poster = await extractPoster(downloaded.file, downloaded.workspace, controller.signal);
      const response = await this.#fetch(request.cloudBaseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'poster_frame',
          grant: request.grant.ticket,
          image: poster.toString('base64')
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        // Debug: the whole path is best-effort and otherwise silent, so the one
        // thing that must not be silent is why the cloud refused a picture.
        const detail = await response.text().catch(() => '');
        console.error('[team-poster] refused:', response.status, detail.slice(0, 300));
        throw new Error('POSTER_REJECTED');
      }
      return { stored: true };
    } finally {
      clearTimeout(deadline);
      this.#active.delete(request.materialId);
      await downloaded?.cleanup().catch(() => undefined);
    }
  }
}

async function extractPoster(
  source: string,
  workspace: string,
  signal: AbortSignal
): Promise<Buffer> {
  // The bundled FFmpeg has no WebP encoder — the whole app encodes WebP through
  // the wasm encoder instead — so the frame comes out as PNG and is converted
  // by the same helper the landing optimizer uses.
  const target = path.join(workspace, 'poster.png');
  const child = spawnManaged(
    activeGovernorOrNull(),
    ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      // Seeking before the input is the cheap seek: ffmpeg jumps rather than
      // decoding a second of video to throw it away.
      '-ss',
      String(POSTER_SEEK_SECONDS),
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      `scale=w='min(${POSTER_MAX_EDGE},iw)':h='min(${POSTER_MAX_EDGE},ih)':force_original_aspect_ratio=decrease`,
      '-pix_fmt',
      'rgba',
      '-c:v',
      'png',
      '-y',
      target
    ],
    { toolId: 'team-poster' }
  );
  const abort = () => child.kill('SIGTERM');
  signal.addEventListener('abort', abort, { once: true });
  const code = await new Promise<number | null>(resolve => {
    child.once('close', value => resolve(value));
    child.once('error', () => resolve(null));
  });
  signal.removeEventListener('abort', abort);
  if (signal.aborted) throw signal.reason ?? new Error('POSTER_CANCELED');
  if (code !== 0) {
    await rm(target, { force: true }).catch(() => undefined);
    // A video whose first second cannot be decoded (a broken head, an exotic
    // codec) is not an error worth retrying forever; the caller records it and
    // the tile keeps its glyph.
    throw new Error('POSTER_UNSUPPORTED');
  }
  const { webp } = await encodeImageToWebp(target, 'optimal');
  return webp;
}

function validate(request: TeamPosterRequest): void {
  if (
    !/^[0-9a-f-]{36}$/iu.test(request.materialId) ||
    typeof request.transferUrl !== 'string' ||
    typeof request.cloudBaseUrl !== 'string' ||
    typeof request.grant?.ticket !== 'string'
  ) {
    throw new Error('INVALID_INPUT');
  }
}
