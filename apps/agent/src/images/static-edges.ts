import { spawnTracked } from '../power/spawn.js';
import { ffmpegPath, MediaToolUnavailableError } from '../ffmpeg/tools.js';

const SAMPLE_WIDTH = 32;
const SAMPLE_HEIGHT = 32;
const SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT;
const STATIC_MEAN_DIFFERENCE = 2.5;

export interface StaticEdgeTrims {
  startSeconds: number;
  endSeconds: number;
}

/**
 * Finds runs of visually static frames at both edges without decoding a long
 * appended still image from beginning to end. Samples are sought
 * exponentially, then the transition is narrowed with a binary search.
 */
export async function detectStaticEdgeTrims(
  input: string,
  durationSeconds: number,
  frameRate: number,
  signal?: AbortSignal
): Promise<StaticEdgeTrims> {
  return staticEdgeScan(input, durationSeconds, frameRate, signal).trims();
}

/**
 * Several questions about one file's edges, sharing one set of decoded frames.
 *
 * Asking them separately decodes the same pictures again: the searches all converge on the
 * same two transitions, and each frame costs an FFmpeg seek. A caller that walks back through
 * a tail asks four or five overlapping questions, so the cache is the difference between one
 * pass over the edges and five.
 */
export interface StaticEdgeScan {
  /** The runs that reach the first and last frames of the file. */
  trims(): Promise<StaticEdgeTrims>;
  /**
   * How many seconds of one held picture end at `endSeconds`, looking back at most
   * `availableSeconds`.
   *
   * `trims` measures the run that reaches the *last* frame, which is all a trim needs to know.
   * A creative can carry more than one held picture at its tail — its own end card, and then a
   * photo screen appended after it — and the appended one hides the card completely, because
   * the card does not match the last frame. Anchoring the same search anywhere lets a caller
   * walk back through them one at a time.
   */
  runEndingAt(endSeconds: number, availableSeconds: number): Promise<number>;
}

export function staticEdgeScan(
  input: string,
  durationSeconds: number,
  frameRate: number,
  signal?: AbortSignal
): StaticEdgeScan {
  const usable =
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0 &&
    Number.isFinite(frameRate) &&
    frameRate > 0;
  const nominalFrames = usable ? Math.max(1, Math.floor(durationSeconds * frameRate)) : 0;
  const sample = usable
    ? frameSampler(input, durationSeconds, frameRate, nominalFrames, signal)
    : null;

  return {
    async trims() {
      if (!sample || nominalFrames < 3) return { startSeconds: 0, endSeconds: 0 };

      // `durationSeconds` comes from the container, which reports the longest
      // stream: a soundtrack that outlives the picture (very common) pushes the
      // nominal frame count past the last real video frame. Seeking there decodes
      // nothing, and an empty sample compares as "different" against everything —
      // which would report a single static trailing frame and leave a previously
      // embedded still image in place. Anchor the tail on a frame that decodes.
      const lastIndex = await lastDecodableIndex(nominalFrames - 1, sample);
      if (lastIndex === null || lastIndex < 2) return { startSeconds: 0, endSeconds: 0 };
      const totalFrames = lastIndex + 1;
      // Whatever the container counts beyond the last picture is audio-only tail.
      // It plays over a frozen frame, so it belongs to the trailing run that is
      // being replaced rather than to the moving source that is being kept.
      const audioOnlyTailSeconds = Math.max(0, durationSeconds - totalFrames / frameRate);

      const leadingFrames = await matchingEdgeFrames(totalFrames, distance => distance, sample);
      const remainingAfterStart = Math.max(2, totalFrames - leadingFrames);
      const trailingFrames = await matchingEdgeFrames(
        remainingAfterStart,
        distance => lastIndex - distance,
        sample
      );
      const safeLeading = Math.min(leadingFrames, totalFrames - 2);
      const safeTrailing = Math.min(trailingFrames, totalFrames - safeLeading - 1);

      return {
        startSeconds: roundSeconds(safeLeading / frameRate),
        endSeconds: roundSeconds(safeTrailing / frameRate + audioOnlyTailSeconds)
      };
    },

    async runEndingAt(endSeconds: number, availableSeconds: number) {
      if (!sample || nominalFrames < 3) return 0;
      if (!Number.isFinite(endSeconds) || endSeconds < 0) return 0;
      const endIndex = Math.min(nominalFrames - 1, Math.max(0, Math.round(endSeconds * frameRate)));
      const available = Math.min(
        endIndex + 1,
        Math.max(0, Math.floor(availableSeconds * frameRate))
      );
      if (available < 2) return 0;
      const frames = await matchingEdgeFrames(available, distance => endIndex - distance, sample);
      return roundSeconds(frames / frameRate);
    }
  };
}

/**
 * Decoded 32×32 grey samples by frame index, each fetched once.
 *
 * Shared so that a caller asking about one run and a caller asking about the next are looking
 * at the same pictures, decoded the same way.
 */
function frameSampler(
  input: string,
  durationSeconds: number,
  frameRate: number,
  nominalFrames: number,
  signal?: AbortSignal
) {
  const cache = new Map<number, Promise<Buffer | null>>();
  return (index: number) => {
    const safeIndex = Math.min(nominalFrames - 1, Math.max(0, index));
    let value = cache.get(safeIndex);
    if (!value) {
      const time = Math.min(Math.max(0, durationSeconds - 1 / frameRate), safeIndex / frameRate);
      value = sampleFrame(input, time, signal);
      cache.set(safeIndex, value);
    }
    return value;
  };
}

/**
 * Highest index that still decodes to a frame, starting from `nominalLast`.
 * Steps back exponentially to land inside the picture, then narrows forward so
 * the anchor is the real last frame rather than an arbitrary earlier one.
 */
async function lastDecodableIndex(
  nominalLast: number,
  sample: (index: number) => Promise<Buffer | null>
) {
  if (await decodes(sample(nominalLast))) return nominalLast;
  let step = 1;
  let decodable = -1;
  let missing = nominalLast;
  while (nominalLast - step >= 0) {
    const index = nominalLast - step;
    if (await decodes(sample(index))) {
      decodable = index;
      break;
    }
    missing = index;
    step *= 2;
  }
  // The exponential walk can step over index 0 entirely; it is the one frame
  // every readable video has, so check it before giving up.
  if (decodable < 0 && missing > 0 && (await decodes(sample(0)))) decodable = 0;
  if (decodable < 0) return null;
  while (missing - decodable > 1) {
    const middle = Math.floor((decodable + missing) / 2);
    if (await decodes(sample(middle))) decodable = middle;
    else missing = middle;
  }
  return decodable;
}

async function decodes(frame: Promise<Buffer | null>) {
  return (await frame) !== null;
}

async function matchingEdgeFrames(
  availableFrames: number,
  indexAtDistance: (distance: number) => number,
  sample: (index: number) => Promise<Buffer | null>
) {
  if (availableFrames < 2) return 0;
  const baseline = await sample(indexAtDistance(0));
  if (!baseline) return 0;
  let matchingDistance = 0;
  let probeDistance = 1;

  while (probeDistance < availableFrames) {
    if (!(await visuallyMatches(baseline, sample(indexAtDistance(probeDistance))))) {
      return firstDifferentDistance(
        baseline,
        matchingDistance + 1,
        probeDistance,
        indexAtDistance,
        sample
      );
    }
    matchingDistance = probeDistance;
    if (probeDistance === availableFrames - 1) return availableFrames;
    probeDistance = Math.min(availableFrames - 1, probeDistance * 2);
  }
  return availableFrames;
}

async function firstDifferentDistance(
  baseline: Buffer,
  low: number,
  high: number,
  indexAtDistance: (distance: number) => number,
  sample: (index: number) => Promise<Buffer | null>
) {
  let left = low;
  let right = high;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (await visuallyMatches(baseline, sample(indexAtDistance(middle)))) left = middle + 1;
    else right = middle;
  }
  return left;
}

async function visuallyMatches(left: Buffer, right: Promise<Buffer | null>) {
  const resolved = await right;
  if (!resolved || left.length !== SAMPLE_BYTES || resolved.length !== SAMPLE_BYTES) return false;
  let difference = 0;
  for (let index = 0; index < SAMPLE_BYTES; index += 1) {
    difference += Math.abs(left[index] - resolved[index]);
  }
  return difference / SAMPLE_BYTES <= STATIC_MEAN_DIFFERENCE;
}

/** Resolves `null` when the seek lands past the last frame and nothing decodes. */
function sampleFrame(input: string, seconds: number, signal?: AbortSignal) {
  return new Promise<Buffer | null>((resolve, reject) => {
    // Abort before spawning: nothing to launch if the caller already gave up.
    if (signal?.aborted) {
      reject(edgeDetectionAborted());
      return;
    }
    const child = spawnTracked(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-ss',
        seconds.toFixed(6),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}:flags=area,format=gray`,
        '-f',
        'rawvideo',
        '-threads',
        '1',
        'pipe:1'
      ],
      { toolId: 'compressor-edges' }
    );
    // Kill the decode as soon as the caller aborts so a cancelled compression or
    // a superseded estimate stops burning CPU instead of running to completion.
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    const detach = () => signal?.removeEventListener('abort', onAbort);
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.once('error', error => {
      detach();
      const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
      if (code) reject(new MediaToolUnavailableError('ffmpeg', code));
      else reject(error);
    });
    child.once('close', code => {
      detach();
      if (signal?.aborted) {
        reject(edgeDetectionAborted());
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr || 'Could not inspect static video edges.'));
        return;
      }
      const frame = Buffer.concat(chunks).subarray(0, SAMPLE_BYTES);
      resolve(frame.length === SAMPLE_BYTES ? frame : null);
    });
  });
}

/** Rejection raised when edge detection is cancelled through its AbortSignal. */
function edgeDetectionAborted() {
  const error = new Error('Static edge detection was cancelled.');
  error.name = 'AbortError';
  return error;
}

function roundSeconds(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
