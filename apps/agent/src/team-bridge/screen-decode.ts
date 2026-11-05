import type { RestitchScreen } from '@video-compressor/shared';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { scaled } from '../power/spawn.js';
import { runTool, toolSucceeded } from '../stitcher/run.js';

export const SCREEN_DECODE_TIMEOUT_MS = 20_000;
// Match the existing catalog image validation ceiling.
export const SCREEN_DECODE_MAX_PIXELS = 16_000_000;
const CODECS: Record<RestitchScreen['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'mjpeg',
  'image/webp': 'webp'
};

/** Full decode using the same managed media engine as stitching; metadata is insufficient. */
export async function decodeRestitchScreen(
  file: string,
  mimeType: RestitchScreen['mimeType'],
  signal: AbortSignal,
  dependencies: { run?: typeof runTool; timeoutMs?: number } = {}
): Promise<boolean> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(),
    scaled(dependencies.timeoutMs ?? SCREEN_DECODE_TIMEOUT_MS)
  );
  timeout.unref();
  try {
    const result = await (dependencies.run ?? runTool)(
      ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-v',
        'error',
        '-xerror',
        '-err_detect',
        'explode',
        '-max_pixels',
        String(SCREEN_DECODE_MAX_PIXELS),
        '-c:v',
        CODECS[mimeType],
        '-i',
        file,
        '-map',
        '0:v:0',
        '-frames:v',
        '2',
        '-fps_mode',
        'passthrough',
        '-progress',
        'pipe:1',
        '-nostats',
        '-f',
        'null',
        '-'
      ],
      { signal: AbortSignal.any([signal, deadline.signal]), killAfterMs: scaled(4_000) }
    );
    signal.throwIfAborted();
    if (deadline.signal.aborted) throw new Error('RESTITCH_SCREEN_SELECTION_LIMIT');
    if (result.spawnErrorCode) throw new Error('MEDIA_TOOL_UNAVAILABLE');
    const frames = [...result.stdout.matchAll(/^frame=\s*(\d+)\s*$/gmu)].map(match =>
      Number(match[1])
    );
    return toolSucceeded(result) && frames.length > 0 && Math.max(...frames) === 1;
  } finally {
    clearTimeout(timeout);
  }
}
