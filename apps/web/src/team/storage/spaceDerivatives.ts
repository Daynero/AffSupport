import {
  SPACE_DERIVATIVE_SPRITE,
  SPACE_DERIVATIVE_VARIANTS,
  spaceMd5Hex
} from '@video-compressor/shared';
import type {
  SpaceDerivativeDeclaration,
  SpaceDerivativeType,
  SpaceDerivativeVariant
} from '@video-compressor/shared';

/**
 * 057 T047: the pictures of a file, made by the browser that uploads it (research R5, FR-038).
 *
 * The browser already has the file, so it makes the explorer's sizes (row, tile, full) and, for a
 * video, the poster and the hover frames, plus the duration and size. They go up as derivative
 * parts of the same commit and the server checks each one. What the browser cannot decode
 * (HEVC on most machines, PDF, exotic containers) is said so, and an agent makes it later; until
 * then the explorer says «preview on its way» and the file downloads as usual.
 *
 * One file at a time for the whole page: decoding is the heavy part, and a drop of fifty photos
 * must not decode fifty at once. Decoding and encoding sit behind small interfaces so tests run
 * without a real decoder (jsdom has none).
 */

export interface SpaceFrame {
  width: number;
  height: number;
  source: CanvasImageSource;
  close?: () => void;
}

export interface SpaceVideoReader {
  durationMs: number;
  width: number;
  height: number;
  frameAt(seconds: number, signal?: AbortSignal): Promise<SpaceFrame>;
  close(): void;
}

export interface SpacePictureDecoder {
  /** The whole picture, oriented; null when this browser cannot decode it. */
  image(file: Blob, signal?: AbortSignal): Promise<SpaceFrame | null>;
  /** Null when this browser cannot play it. */
  video(file: Blob, signal?: AbortSignal): Promise<SpaceVideoReader | null>;
}

export interface SpaceCanvasEncoder {
  /**
   * Draws `cells` (each a frame and where it goes) on a canvas of `width × height` and encodes it.
   * Returns the blob and the type the browser actually produced.
   */
  encode(input: {
    width: number;
    height: number;
    cells: ReadonlyArray<{
      frame: SpaceFrame;
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
    type: SpaceDerivativeType;
    quality: number;
  }): Promise<Blob | null>;
}

export interface SpaceMadeDerivative extends SpaceDerivativeDeclaration {
  blob: Blob;
}

export interface SpaceMadeDerivatives {
  derivatives: SpaceMadeDerivative[];
  media: { durationMs: number | null; width: number | null; height: number | null } | null;
  /** The browser could not decode the file at all: an agent will make its pictures. */
  unsupported: boolean;
}

export type SpaceDerivativeMaker = (
  file: Blob,
  options: { contentType: string; slots: readonly SpaceDerivativeVariant[]; signal?: AbortSignal }
) => Promise<SpaceMadeDerivatives>;

/** Quality steps tried until a picture fits its variant's byte limit. */
const QUALITIES = [0.82, 0.7, 0.55, 0.4];
const STEP_TIMEOUT_MS = 15_000;
/** One second in, as the agent's poster: a fade from black is not what a folder should show. */
const POSTER_SECONDS = 1;

/** The size of `width × height` fitted inside `edge × edge`, never enlarged. */
export function fitWithin(
  width: number,
  height: number,
  edge: number
): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/** Where each hover frame is taken: the middles of equal slices of the video. */
export function spriteTimes(durationMs: number): number[] {
  const seconds = durationMs / 1000;
  const frames = SPACE_DERIVATIVE_SPRITE.frames;
  return Array.from({ length: frames }, (_, index) => ((index + 0.5) * seconds) / frames);
}

export function posterTime(durationMs: number): number {
  const seconds = durationMs / 1000;
  return seconds > POSTER_SECONDS * 2 ? POSTER_SECONDS : seconds / 2;
}

async function encodeFitting(
  encoder: SpaceCanvasEncoder,
  variant: SpaceDerivativeVariant,
  width: number,
  height: number,
  cells: Parameters<SpaceCanvasEncoder['encode']>[0]['cells']
): Promise<SpaceMadeDerivative | null> {
  const limit = SPACE_DERIVATIVE_VARIANTS[variant];
  for (const type of ['image/webp', 'image/jpeg'] as const) {
    for (const quality of QUALITIES) {
      const blob = await encoder.encode({ width, height, cells, type, quality });
      // A browser that cannot write WebP hands back PNG: try JPEG instead.
      if (!blob || blob.type !== type) break;
      if (blob.size < 1 || blob.size > limit.maxBytes) continue;
      return {
        variant,
        contentType: type,
        bytes: blob.size,
        width,
        height,
        md5: spaceMd5Hex(new Uint8Array(await blob.arrayBuffer())),
        blob
      };
    }
  }
  return null;
}

function single(frame: SpaceFrame, size: { width: number; height: number }) {
  return [{ frame, x: 0, y: 0, width: size.width, height: size.height }];
}

async function sizesOf(
  encoder: SpaceCanvasEncoder,
  frame: SpaceFrame,
  variants: readonly SpaceDerivativeVariant[]
): Promise<SpaceMadeDerivative[]> {
  const out: SpaceMadeDerivative[] = [];
  for (const variant of variants) {
    const limit = SPACE_DERIVATIVE_VARIANTS[variant];
    const size = fitWithin(frame.width, frame.height, Math.min(limit.maxWidth, limit.maxHeight));
    const made = await encodeFitting(
      encoder,
      variant,
      size.width,
      size.height,
      single(frame, size)
    );
    if (made) out.push(made);
  }
  return out;
}

/** The pictures of one file, by the injected decoder and encoder. */
export async function deriveSpacePictures(
  file: Blob,
  options: {
    contentType: string;
    slots: readonly SpaceDerivativeVariant[];
    signal?: AbortSignal;
    decoder: SpacePictureDecoder;
    encoder: SpaceCanvasEncoder;
  }
): Promise<SpaceMadeDerivatives> {
  const { slots, decoder, encoder, signal } = options;
  const stills = slots.filter(slot => slot === 'row' || slot === 'tile' || slot === 'full');
  if (
    slots.includes('poster') ||
    slots.includes('sprite') ||
    options.contentType.startsWith('video/')
  ) {
    const reader = await decoder.video(file, signal).catch(() => null);
    if (!reader) return { derivatives: [], media: null, unsupported: true };
    try {
      const media = { durationMs: reader.durationMs, width: reader.width, height: reader.height };
      const out: SpaceMadeDerivative[] = [];
      const poster = await reader.frameAt(posterTime(reader.durationMs), signal).catch(() => null);
      // It opened but will not show a frame (a codec the browser only half knows): an agent's.
      if (!poster) return { derivatives: [], media, unsupported: true };
      try {
        out.push(
          ...(await sizesOf(encoder, poster, [
            ...stills,
            ...(slots.includes('poster') ? ['poster' as const] : [])
          ]))
        );
      } finally {
        poster.close?.();
      }
      if (slots.includes('sprite') && reader.durationMs > 0) {
        const frames: SpaceFrame[] = [];
        try {
          for (const at of spriteTimes(reader.durationMs))
            frames.push(await reader.frameAt(at, signal));
          const cell = fitWithin(reader.width, reader.height, SPACE_DERIVATIVE_SPRITE.frameMaxEdge);
          const columns = SPACE_DERIVATIVE_SPRITE.columns;
          const rows = Math.ceil(frames.length / columns);
          const sprite = await encodeFitting(
            encoder,
            'sprite',
            cell.width * columns,
            cell.height * rows,
            frames.map((frame, index) => ({
              frame,
              x: (index % columns) * cell.width,
              y: Math.floor(index / columns) * cell.height,
              width: cell.width,
              height: cell.height
            }))
          );
          if (sprite) out.push(sprite);
        } catch {
          // No hover frames: the rest still stands.
        } finally {
          for (const frame of frames) frame.close?.();
        }
      }
      return { derivatives: out, media, unsupported: false };
    } finally {
      reader.close();
    }
  }
  if (stills.length === 0) return { derivatives: [], media: null, unsupported: false };
  const frame = await decoder.image(file, signal).catch(() => null);
  if (!frame) return { derivatives: [], media: null, unsupported: true };
  try {
    return {
      derivatives: await sizesOf(encoder, frame, stills),
      media: { durationMs: null, width: frame.width, height: frame.height },
      unsupported: false
    };
  } finally {
    frame.close?.();
  }
}

// The browser's decoder and encoder -------------------------------------------------------

function timeout<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DERIVATIVE_TIMEOUT')), STEP_TIMEOUT_MS);
    const onAbort = () => reject(signal?.reason ?? new Error('CANCELED'));
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function once(target: EventTarget, ok: string, fail = 'error'): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      target.removeEventListener(ok, onOk);
      target.removeEventListener(fail, onFail);
    };
    const onOk = () => {
      done();
      resolve();
    };
    const onFail = () => {
      done();
      reject(new Error('DECODE_FAILED'));
    };
    target.addEventListener(ok, onOk);
    target.addEventListener(fail, onFail);
  });
}

export const browserPictureDecoder: SpacePictureDecoder = {
  async image(file, signal) {
    if (typeof createImageBitmap !== 'function') return null;
    try {
      const bitmap = await timeout(
        createImageBitmap(file, { imageOrientation: 'from-image' }),
        signal
      );
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap,
        close: () => bitmap.close()
      };
    } catch {
      return null;
    }
  },
  async video(file, signal) {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    const close = () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };
    try {
      const loaded = once(video, 'loadeddata');
      video.src = url;
      await timeout(loaded, signal);
      if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) {
        close();
        return null;
      }
    } catch {
      close();
      return null;
    }
    return {
      durationMs: Math.round(video.duration * 1000),
      width: video.videoWidth,
      height: video.videoHeight,
      async frameAt(seconds, frameSignal) {
        const seeked = once(video, 'seeked');
        video.currentTime = Math.min(Math.max(0, seconds), Math.max(0, video.duration - 0.05));
        await timeout(seeked, frameSignal);
        return { width: video.videoWidth, height: video.videoHeight, source: video };
      },
      close
    };
  }
};

export const browserCanvasEncoder: SpaceCanvasEncoder = {
  async encode({ width, height, cells, type, quality }) {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) return null;
      for (const cell of cells)
        context.drawImage(cell.frame.source, cell.x, cell.y, cell.width, cell.height);
      return canvas.convertToBlob({ type, quality }).catch(() => null);
    }
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    for (const cell of cells)
      context.drawImage(cell.frame.source, cell.x, cell.y, cell.width, cell.height);
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob), type, quality));
  }
};

let queue: Promise<unknown> = Promise.resolve();

/** The page's maker: the browser's own decoder and encoder, one file at a time. */
export const makeSpaceDerivatives: SpaceDerivativeMaker = (file, options) => {
  const run = queue.then(() =>
    deriveSpacePictures(file, {
      ...options,
      decoder: browserPictureDecoder,
      encoder: browserCanvasEncoder
    })
  );
  queue = run.catch(() => undefined);
  return run;
};
