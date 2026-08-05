import { spawn } from 'node:child_process';
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
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isFinite(frameRate) ||
    frameRate <= 0
  ) {
    return { startSeconds: 0, endSeconds: 0 };
  }

  const totalFrames = Math.max(1, Math.floor(durationSeconds * frameRate));
  if (totalFrames < 3) return { startSeconds: 0, endSeconds: 0 };
  const cache = new Map<number, Promise<Buffer>>();
  const sample = (index: number) => {
    const safeIndex = Math.min(totalFrames - 1, Math.max(0, index));
    let value = cache.get(safeIndex);
    if (!value) {
      const time = Math.min(Math.max(0, durationSeconds - 1 / frameRate), safeIndex / frameRate);
      value = sampleFrame(input, time, signal);
      cache.set(safeIndex, value);
    }
    return value;
  };

  const leadingFrames = await matchingEdgeFrames(totalFrames, distance => distance, sample);
  const remainingAfterStart = Math.max(2, totalFrames - leadingFrames);
  const trailingFrames = await matchingEdgeFrames(
    remainingAfterStart,
    distance => totalFrames - 1 - distance,
    sample
  );
  const safeLeading = Math.min(leadingFrames, totalFrames - 2);
  const safeTrailing = Math.min(trailingFrames, totalFrames - safeLeading - 1);

  return {
    startSeconds: roundSeconds(safeLeading / frameRate),
    endSeconds: roundSeconds(safeTrailing / frameRate)
  };
}

async function matchingEdgeFrames(
  availableFrames: number,
  indexAtDistance: (distance: number) => number,
  sample: (index: number) => Promise<Buffer>
) {
  if (availableFrames < 2) return 0;
  const baseline = await sample(indexAtDistance(0));
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
  sample: (index: number) => Promise<Buffer>
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

async function visuallyMatches(left: Buffer, right: Promise<Buffer>) {
  const resolved = await right;
  if (left.length !== SAMPLE_BYTES || resolved.length !== SAMPLE_BYTES) return false;
  let difference = 0;
  for (let index = 0; index < SAMPLE_BYTES; index += 1) {
    difference += Math.abs(left[index] - resolved[index]);
  }
  return difference / SAMPLE_BYTES <= STATIC_MEAN_DIFFERENCE;
}

function sampleFrame(input: string, seconds: number, signal?: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    // Abort before spawning: nothing to launch if the caller already gave up.
    if (signal?.aborted) {
      reject(edgeDetectionAborted());
      return;
    }
    const child = spawn(
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
      { shell: false }
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
      if (code === 0) resolve(Buffer.concat(chunks).subarray(0, SAMPLE_BYTES));
      else reject(new Error(stderr || 'Could not inspect static video edges.'));
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
