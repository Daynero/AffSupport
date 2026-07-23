import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { currentModelPath, whisperPath, whisperVadModelPath } from './tools.js';

export interface TranscribeOptions {
  inputPath: string;
  /** Final `.txt` path written next to the source. */
  transcriptPath: string;
  /** `auto` or an ISO 639-1 code. */
  language: string;
  onProgress: (value: number | null) => void;
}

export interface TranscribeResult {
  code: number | null;
  cancelled: boolean;
  text: string;
  detectedLanguage: string | null;
  stderr: string;
  failedStage: 'extract' | 'transcribe' | null;
  spawnErrorCode: string | null;
}

export interface TranscribeHandle {
  cancel: () => void;
  done: Promise<TranscribeResult>;
}

// Audio extraction is quick relative to inference; give it the first slice of
// the progress bar so the whisper phase reads as steady forward motion.
const EXTRACT_SHARE = 6;
const DETECT_END = 12;
const CHUNK_PREP_END = 15;
const PRIMARY_TRANSCRIBE_END = 88;
const BRIDGE_PREP_END = 90;
const INFERENCE_END = 99;
const SPEECH_CHUNK_MS = 12_000;
const SPEECH_CHUNK_OVERLAP_MS = 6_000;
const SPEECH_CONTEXT_CHUNK_MS = 20_000;
const MERGE_SPEECH_GAP_MS = 750;
const SPEECH_EDGE_PADDING_MS = 250;

export interface SpeechRange {
  startMs: number;
  endMs: number;
}

export interface BridgeChunk {
  beforeIndex: number;
  range: SpeechRange;
}

/**
 * Extracts a normalized 16 kHz mono WAV, detects speech with Silero, then
 * transcribes bounded overlapping windows. Returns a handle so the queue can
 * cancel the active child at any point.
 */
export function transcribe(options: TranscribeOptions): TranscribeHandle {
  const { inputPath, transcriptPath, language, onProgress } = options;
  let activeChild: ChildProcessWithoutNullStreams | null = null;
  let cancelled = false;

  const kill = () => {
    cancelled = true;
    activeChild?.kill('SIGTERM');
  };

  const done = (async (): Promise<TranscribeResult> => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'wishly-transcribe-'));
    const wavPath = path.join(tmpDir, 'audio.wav');
    const cleanup = () => void rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    try {
      onProgress(0);
      const extract = await runExtract(inputPath, wavPath, child => {
        activeChild = child;
      });
      if (cancelled) return result(null, true, '', null, extract.stderr, null, null);
      if (extract.spawnErrorCode) {
        return result(null, false, '', null, extract.stderr, 'extract', extract.spawnErrorCode);
      }
      if (extract.code !== 0) {
        return result(extract.code, false, '', null, extract.stderr, 'extract', null);
      }
      onProgress(EXTRACT_SHARE);

      if (existsSync(whisperVadModelPath)) {
        const detection = await runVadDetection({ wavPath }, child => {
          activeChild = child;
        });
        if (cancelled) {
          return result(null, true, '', null, detection.stderr, null, null);
        }
        if (detection.spawnErrorCode) {
          return result(
            null,
            false,
            '',
            requestedOrDetectedLanguage(language, detection.detectedLanguage),
            detection.stderr,
            'transcribe',
            detection.spawnErrorCode
          );
        }
        if (detection.code !== 0) {
          return result(
            detection.code,
            false,
            '',
            requestedOrDetectedLanguage(language, detection.detectedLanguage),
            detection.stderr,
            'transcribe',
            null
          );
        }

        const detectedLanguage = requestedOrDetectedLanguage(language, detection.detectedLanguage);
        const ranges = buildSpeechChunks(detection.speechRanges);
        onProgress(DETECT_END);
        if (ranges.length === 0) {
          await writeFile(transcriptPath, '', 'utf8');
          onProgress(100);
          return result(0, false, '', detectedLanguage, detection.stderr, null, null);
        }

        const chunkPaths: string[] = [];
        let diagnostics = detection.stderr;
        for (let index = 0; index < ranges.length; index += 1) {
          const chunkPath = path.join(tmpDir, `speech-${String(index).padStart(4, '0')}.wav`);
          const clip = await runExtractClip(wavPath, chunkPath, ranges[index], child => {
            activeChild = child;
          });
          diagnostics = appendDiagnostics(diagnostics, clip.stderr);
          if (cancelled) {
            return result(null, true, '', detectedLanguage, diagnostics, null, null);
          }
          if (clip.spawnErrorCode) {
            return result(
              null,
              false,
              '',
              detectedLanguage,
              diagnostics,
              'extract',
              clip.spawnErrorCode
            );
          }
          if (clip.code !== 0) {
            return result(clip.code, false, '', detectedLanguage, diagnostics, 'extract', null);
          }
          chunkPaths.push(chunkPath);
          onProgress(DETECT_END + ((index + 1) * (CHUNK_PREP_END - DETECT_END)) / ranges.length);
        }

        const chunkRun = await runChunkWhisper(
          {
            wavPaths: chunkPaths,
            language: detectedLanguage ?? language
          },
          child => {
            activeChild = child;
          },
          completed =>
            onProgress(
              CHUNK_PREP_END +
                (completed * (PRIMARY_TRANSCRIBE_END - CHUNK_PREP_END)) / chunkPaths.length
            )
        );
        diagnostics = appendDiagnostics(diagnostics, chunkRun.stderr);
        if (cancelled) {
          return result(null, true, '', detectedLanguage, diagnostics, null, null);
        }
        if (chunkRun.spawnErrorCode) {
          return result(
            null,
            false,
            '',
            detectedLanguage,
            diagnostics,
            'transcribe',
            chunkRun.spawnErrorCode
          );
        }
        if (chunkRun.code !== 0) {
          return result(
            chunkRun.code,
            false,
            '',
            detectedLanguage,
            diagnostics,
            'transcribe',
            null
          );
        }

        const chunks = await Promise.all(chunkPaths.map(chunkPath => readRawTranscript(chunkPath)));
        const bridges = buildBridgeChunks(ranges, chunks);
        const bridgeTexts: string[] = [];
        if (bridges.length > 0) {
          const bridgePaths: string[] = [];
          for (let index = 0; index < bridges.length; index += 1) {
            const bridgePath = path.join(tmpDir, `bridge-${String(index).padStart(4, '0')}.wav`);
            const clip = await runExtractClip(wavPath, bridgePath, bridges[index].range, child => {
              activeChild = child;
            });
            diagnostics = appendDiagnostics(diagnostics, clip.stderr);
            if (cancelled) {
              return result(null, true, '', detectedLanguage, diagnostics, null, null);
            }
            if (clip.spawnErrorCode) {
              return result(
                null,
                false,
                '',
                detectedLanguage,
                diagnostics,
                'extract',
                clip.spawnErrorCode
              );
            }
            if (clip.code !== 0) {
              return result(clip.code, false, '', detectedLanguage, diagnostics, 'extract', null);
            }
            bridgePaths.push(bridgePath);
            onProgress(
              PRIMARY_TRANSCRIBE_END +
                ((index + 1) * (BRIDGE_PREP_END - PRIMARY_TRANSCRIBE_END)) / bridges.length
            );
          }

          const bridgeRun = await runChunkWhisper(
            {
              wavPaths: bridgePaths,
              language: detectedLanguage ?? language,
              preserveTimestamps: true
            },
            child => {
              activeChild = child;
            },
            completed =>
              onProgress(
                BRIDGE_PREP_END +
                  (completed * (INFERENCE_END - BRIDGE_PREP_END)) / bridgePaths.length
              )
          );
          diagnostics = appendDiagnostics(diagnostics, bridgeRun.stderr);
          if (cancelled) {
            return result(null, true, '', detectedLanguage, diagnostics, null, null);
          }
          if (bridgeRun.spawnErrorCode) {
            return result(
              null,
              false,
              '',
              detectedLanguage,
              diagnostics,
              'transcribe',
              bridgeRun.spawnErrorCode
            );
          }
          if (bridgeRun.code !== 0) {
            return result(
              bridgeRun.code,
              false,
              '',
              detectedLanguage,
              diagnostics,
              'transcribe',
              null
            );
          }
          bridgeTexts.push(
            ...(await Promise.all(bridgePaths.map(bridgePath => readRawTranscript(bridgePath))))
          );
        }

        const refinedChunks: string[] = [];
        for (let index = 0; index < chunks.length; index += 1) {
          for (let bridgeIndex = 0; bridgeIndex < bridges.length; bridgeIndex += 1) {
            if (bridges[bridgeIndex].beforeIndex === index) {
              refinedChunks.push(bridgeTexts[bridgeIndex] ?? '');
            }
          }
          refinedChunks.push(chunks[index]);
        }
        const text = mergeTranscriptChunks(refinedChunks);
        await writeFile(transcriptPath, text ? `${text}\n` : '', 'utf8');
        onProgress(100);
        return result(0, false, text, detectedLanguage, diagnostics, null, null);
      }

      // Compatibility fallback for source builds that do not have the bundled
      // Silero model. Production builds use the short-window path above.
      const outputBase = path.join(tmpDir, 'transcript');
      const run = await runWhisper(
        { wavPath, outputBase, language },
        child => {
          activeChild = child;
        },
        value =>
          onProgress(value === null ? null : EXTRACT_SHARE + (value * (100 - EXTRACT_SHARE)) / 100)
      );
      if (cancelled) return result(null, true, '', null, run.stderr, null, null);
      if (run.spawnErrorCode) {
        return result(
          null,
          false,
          '',
          run.detectedLanguage,
          run.stderr,
          'transcribe',
          run.spawnErrorCode
        );
      }
      if (run.code !== 0) {
        return result(run.code, false, '', run.detectedLanguage, run.stderr, 'transcribe', null);
      }

      const text = await readTranscript(`${outputBase}.txt`);
      await writeFile(transcriptPath, text ? `${text}\n` : '', 'utf8');
      onProgress(100);
      return result(0, false, text, run.detectedLanguage, run.stderr, null, null);
    } finally {
      cleanup();
    }
  })();

  return { cancel: kill, done };

  function result(
    code: number | null,
    wasCancelled: boolean,
    text: string,
    detectedLanguage: string | null,
    stderr: string,
    failedStage: 'extract' | 'transcribe' | null,
    spawnErrorCode: string | null
  ): TranscribeResult {
    return {
      code,
      cancelled: wasCancelled,
      text,
      detectedLanguage,
      stderr,
      failedStage,
      spawnErrorCode
    };
  }
}

function runExtract(
  inputPath: string,
  wavPath: string,
  onChild: (child: ChildProcessWithoutNullStreams) => void
): Promise<{ code: number | null; stderr: string; spawnErrorCode: string | null }> {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    '-y',
    wavPath
  ];
  return new Promise(resolve => {
    const child = spawn(ffmpegPath, args, { shell: false });
    onChild(child);
    let stderr = '';
    let spawnErrorCode: string | null = null;
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.once('error', error => {
      spawnErrorCode =
        'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED';
    });
    child.once('close', code => resolve({ code, stderr, spawnErrorCode }));
  });
}

function runExtractClip(
  wavPath: string,
  chunkPath: string,
  range: SpeechRange,
  onChild: (child: ChildProcessWithoutNullStreams) => void
): Promise<{ code: number | null; stderr: string; spawnErrorCode: string | null }> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-ss',
    (range.startMs / 1000).toFixed(3),
    '-t',
    ((range.endMs - range.startMs) / 1000).toFixed(3),
    '-i',
    wavPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    '-y',
    chunkPath
  ];
  return new Promise(resolve => {
    const child = spawn(ffmpegPath, args, { shell: false });
    onChild(child);
    let stderr = '';
    let spawnErrorCode: string | null = null;
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.once('error', error => {
      spawnErrorCode =
        'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED';
    });
    child.once('close', code => resolve({ code, stderr, spawnErrorCode }));
  });
}

function runVadDetection(
  params: { wavPath: string },
  onChild: (child: ChildProcessWithoutNullStreams) => void
): Promise<{
  code: number | null;
  stderr: string;
  detectedLanguage: string | null;
  speechRanges: SpeechRange[];
  spawnErrorCode: string | null;
}> {
  const args = buildVadDetectionArgs(params);
  return new Promise(resolve => {
    const child = spawn(whisperPath, args, { shell: false });
    onChild(child);
    let output = '';
    let stderr = '';
    let detectedLanguage: string | null = null;
    let spawnErrorCode: string | null = null;
    const consume = (chunk: Buffer) => {
      const value = chunk.toString();
      output += value;
      stderr = (stderr + value).slice(-12_000);
      const detected = /auto-detected language:\s*([a-z]{2,3})/i.exec(value);
      if (detected) detectedLanguage = detected[1].toLowerCase();
    };
    child.stderr.on('data', consume);
    child.stdout.on('data', consume);
    child.once('error', error => {
      spawnErrorCode =
        'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED';
    });
    child.once('close', code => {
      const detected = /auto-detected language:\s*([a-z]{2,3})/i.exec(output);
      resolve({
        code,
        stderr,
        detectedLanguage: detectedLanguage ?? detected?.[1]?.toLowerCase() ?? null,
        speechRanges: parseVadSpeechRanges(output),
        spawnErrorCode
      });
    });
  });
}

function runChunkWhisper(
  params: { wavPaths: string[]; language: string; preserveTimestamps?: boolean },
  onChild: (child: ChildProcessWithoutNullStreams) => void,
  onChunkComplete: (completed: number) => void
): Promise<{
  code: number | null;
  stderr: string;
  spawnErrorCode: string | null;
}> {
  const args = buildChunkWhisperArgs(params, {
    preserveTimestamps: params.preserveTimestamps
  });
  return new Promise(resolve => {
    const child = spawn(whisperPath, args, { shell: false });
    onChild(child);
    let stderr = '';
    let completed = 0;
    let spawnErrorCode: string | null = null;
    const consume = (chunk: Buffer) => {
      const value = chunk.toString();
      stderr = (stderr + value).slice(-12_000);
      const saved = value.match(/output_txt:\s+saving output to/gi)?.length ?? 0;
      for (let index = 0; index < saved; index += 1) {
        completed += 1;
        onChunkComplete(Math.min(completed, params.wavPaths.length));
      }
    };
    child.stderr.on('data', consume);
    child.stdout.on('data', consume);
    child.once('error', error => {
      spawnErrorCode =
        'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED';
    });
    child.once('close', code => resolve({ code, stderr, spawnErrorCode }));
  });
}

function runWhisper(
  params: { wavPath: string; outputBase: string; language: string },
  onChild: (child: ChildProcessWithoutNullStreams) => void,
  onProgress: (value: number | null) => void
): Promise<{
  code: number | null;
  stderr: string;
  detectedLanguage: string | null;
  spawnErrorCode: string | null;
}> {
  const args = buildWhisperArgs(params);
  return new Promise(resolve => {
    const child = spawn(whisperPath, args, { shell: false });
    onChild(child);
    let stderr = '';
    let detectedLanguage: string | null =
      params.language && params.language !== 'auto' ? params.language : null;
    let spawnErrorCode: string | null = null;
    const consume = (chunk: Buffer) => {
      const value = chunk.toString();
      stderr = (stderr + value).slice(-12_000);
      const progress = /progress\s*=\s*(\d+)\s*%/.exec(value);
      if (progress) onProgress(Math.min(99, Number(progress[1])));
      const detected = /auto-detected language:\s*([a-z]{2,3})/i.exec(value);
      if (detected) detectedLanguage = detected[1].toLowerCase();
    };
    // whisper.cpp prints progress and the detected language on stderr, the
    // transcript on stdout — watch both.
    child.stderr.on('data', consume);
    child.stdout.on('data', consume);
    child.once('error', error => {
      spawnErrorCode =
        'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED';
    });
    child.once('close', code => resolve({ code, stderr, detectedLanguage, spawnErrorCode }));
  });
}

export function buildWhisperArgs(
  params: { wavPath: string; outputBase: string; language: string },
  options: { threads?: number; vadModelPath?: string | null } = {}
): string[] {
  const threads = options.threads ?? Math.max(4, os.cpus().length - 2);
  const vadModelPath =
    options.vadModelPath === undefined
      ? existsSync(whisperVadModelPath)
        ? whisperVadModelPath
        : null
      : options.vadModelPath;
  const args = [
    '-m',
    currentModelPath(),
    '-f',
    params.wavPath,
    '-l',
    params.language || 'auto',
    '-otxt',
    '-of',
    params.outputBase,
    '-pp',
    // Keep timestamp tokens enabled internally for reliable long-form
    // segmentation. `-otxt` still writes plain text without timecodes, while
    // whisper.cpp's `-nt` mode can skip speech and loop on earlier phrases.
    // Accuracy: beam search + best-of temperature fallback recover far more of
    // the audio than greedy decoding, especially on noisy or accented speech.
    '-bs',
    '5',
    '-bo',
    '5',
    // Suppress non-speech tokens (harmless to real words) to trim noise symbols.
    '-sns',
    '-t',
    String(threads),
    // Gentle VAD: only skip genuine silence so the tail can't be hallucinated,
    // but keep quiet/soft speech. A low threshold + generous padding + a longer
    // required silence gap prevent VAD from clipping real sentences. Context is
    // left intact (no -mc 0) because VAD + dedup already contain repetition.
    ...(vadModelPath
      ? ['--vad', '-vm', vadModelPath, '-vt', '0.30', '-vp', '250', '-vsd', '400']
      : [])
  ];
  return args;
}

export function buildVadDetectionArgs(
  params: { wavPath: string },
  options: { threads?: number; vadModelPath?: string } = {}
): string[] {
  const threads = options.threads ?? Math.max(4, os.cpus().length - 2);
  const vadModelPath = options.vadModelPath ?? whisperVadModelPath;
  return [
    '-m',
    currentModelPath(),
    '-f',
    params.wavPath,
    '-l',
    'auto',
    '-dl',
    '-t',
    String(threads),
    '--vad',
    '-vm',
    vadModelPath,
    '-vt',
    '0.30',
    '-vp',
    '250',
    '-vsd',
    '400'
  ];
}

export function buildChunkWhisperArgs(
  params: { wavPaths: string[]; language: string },
  options: { threads?: number; preserveTimestamps?: boolean } = {}
): string[] {
  const threads = options.threads ?? Math.max(4, os.cpus().length - 2);
  return [
    '-m',
    currentModelPath(),
    '-l',
    params.language || 'auto',
    '-otxt',
    // The primary bounded pass uses no-timestamp decoding for speed and stable
    // phrasing. A recovery pass deliberately keeps timestamp tokens enabled:
    // this gives a failing boundary a genuinely different decoder path, while
    // `-otxt` still writes the same plain text without timecodes.
    ...(options.preserveTimestamps ? [] : ['-nt']),
    // Temperature retries can replace a complete beam result with a shorter
    // one. Deterministic beam search proved both fuller and much faster.
    '-nf',
    '-np',
    '-bs',
    '5',
    '-bo',
    '5',
    '-sns',
    '-t',
    String(threads),
    ...params.wavPaths
  ];
}

export function parseVadSpeechRanges(output: string): SpeechRange[] {
  const ranges: SpeechRange[] = [];
  const seen = new Set<string>();
  const pattern =
    /\bVAD segment\s+\d+:\s+start\s*=\s*(\d+(?:\.\d+)?),\s+end\s*=\s*(\d+(?:\.\d+)?)/gi;
  for (const match of output.matchAll(pattern)) {
    const startMs = Math.round(Number(match[1]) * 1000);
    const endMs = Math.round(Number(match[2]) * 1000);
    const key = `${startMs}:${endMs}`;
    if (endMs <= startMs || seen.has(key)) continue;
    seen.add(key);
    ranges.push({ startMs, endMs });
  }
  return ranges.sort((left, right) => left.startMs - right.startMs);
}

export function buildSpeechChunks(
  speechRanges: SpeechRange[],
  options: {
    chunkMs?: number;
    overlapMs?: number;
    mergeGapMs?: number;
    contextChunkMs?: number;
    edgePaddingMs?: number;
  } = {}
): SpeechRange[] {
  const chunkMs = options.chunkMs ?? SPEECH_CHUNK_MS;
  const overlapMs = options.overlapMs ?? SPEECH_CHUNK_OVERLAP_MS;
  const mergeGapMs = options.mergeGapMs ?? MERGE_SPEECH_GAP_MS;
  const contextChunkMs = Math.max(chunkMs, options.contextChunkMs ?? SPEECH_CONTEXT_CHUNK_MS);
  const edgePaddingMs = options.edgePaddingMs ?? SPEECH_EDGE_PADDING_MS;
  const strideMs = chunkMs - overlapMs;
  if (chunkMs <= 0 || overlapMs < 0 || strideMs <= 0) return [];

  const merged: SpeechRange[] = [];
  for (const range of speechRanges
    .filter(range => range.endMs > range.startMs)
    .map(range => ({
      startMs: Math.max(0, range.startMs - edgePaddingMs),
      endMs: range.endMs + edgePaddingMs
    }))
    .sort((left, right) => left.startMs - right.startMs)) {
    const previous = merged.at(-1);
    if (previous && range.startMs - previous.endMs <= mergeGapMs) {
      previous.endMs = Math.max(previous.endMs, range.endMs);
    } else {
      merged.push({ ...range });
    }
  }

  const chunks: SpeechRange[] = [];
  for (const range of merged) {
    if (range.endMs - range.startMs <= chunkMs) {
      chunks.push({ ...range });
      continue;
    }

    // Give the first words extra right-hand context. The bounded windows below
    // still guarantee coverage if this longer anchor reaches the token limit.
    chunks.push({
      startMs: range.startMs,
      endMs: Math.min(range.endMs, range.startMs + contextChunkMs)
    });
    let lastStart = range.startMs;
    let cursor = range.startMs + strideMs;
    while (cursor + chunkMs < range.endMs) {
      chunks.push({ startMs: cursor, endMs: cursor + chunkMs });
      lastStart = cursor;
      cursor += strideMs;
    }

    const finalStart = Math.max(range.startMs, range.endMs - chunkMs);
    if (finalStart - lastStart < 1000) {
      chunks[chunks.length - 1].endMs = range.endMs;
    } else {
      chunks.push({ startMs: finalStart, endMs: range.endMs });
    }
  }
  return chunks;
}

export function buildBridgeChunks(
  ranges: SpeechRange[],
  transcripts: string[],
  contextMs = SPEECH_CONTEXT_CHUNK_MS
): BridgeChunk[] {
  const bridges: BridgeChunk[] = [];
  for (let index = 1; index < Math.min(ranges.length, transcripts.length); index += 1) {
    const leftRange = ranges[index - 1];
    const rightRange = ranges[index];
    const leftText = transcripts[index - 1].trim();
    const rightText = transcripts[index].trim();
    const stepMs = rightRange.startMs - leftRange.startMs;
    if (
      stepMs <= 0 ||
      rightRange.startMs >= leftRange.endMs ||
      (leftText && rightText && findTranscriptOverlap(leftText, rightText))
    ) {
      continue;
    }

    // Re-decode the union of both disagreeing windows so the model sees
    // context before and after the failed seam. Normal 12-second windows with
    // 50% overlap produce an 18-second union. If callers provide wider ranges,
    // keep the retry bounded and center it on their shared audio.
    const unionStart = leftRange.startMs;
    const unionEnd = rightRange.endMs;
    const unionDuration = unionEnd - unionStart;
    let startMs = unionStart;
    let endMs = unionEnd;
    if (unionDuration > contextMs) {
      const overlapCenter = Math.round(
        (Math.max(leftRange.startMs, rightRange.startMs) +
          Math.min(leftRange.endMs, rightRange.endMs)) /
          2
      );
      startMs = Math.max(
        unionStart,
        Math.min(unionEnd - contextMs, Math.round(overlapCenter - contextMs / 2))
      );
      endMs = startMs + contextMs;
    }
    bridges.push({
      beforeIndex: index,
      range: { startMs, endMs }
    });
  }
  return bridges;
}

async function readTranscript(transcriptPath: string): Promise<string> {
  try {
    const raw = await readFile(transcriptPath, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    return collapseTranscriptArtifacts(lines).join('\n').trim();
  } catch {
    return '';
  }
}

async function readRawTranscript(wavPath: string): Promise<string> {
  try {
    return await readFile(`${wavPath}.txt`, 'utf8');
  } catch {
    return '';
  }
}

export function mergeTranscriptChunks(chunks: string[]): string {
  const clean = chunks
    .map(chunk =>
      chunk
        .replace(/\uFFFD+/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
    )
    .filter(Boolean);
  if (clean.length === 0) return '';

  let merged = clean[0];
  for (const chunk of clean.slice(1)) {
    const overlap = findTranscriptOverlap(merged, chunk);
    if (!overlap) {
      merged = `${merged}\n${chunk}`;
      continue;
    }

    // Prefer the newer window inside the shared audio. It has more context
    // after the boundary and can replace a clipped or hallucinated left tail.
    const left = merged.slice(0, overlap.leftStart).trimEnd();
    const right = chunk.slice(overlap.rightStart).trimStart();
    merged = joinTranscriptText(left, right);
  }

  const lines = merged
    .replace(/[^\S\r\n]+/gu, ' ')
    .split(/(?<=[.!?…।॥؟。！？])(?:\s+|\n+)/u)
    .flatMap(line => line.split(/\n+/u))
    .map(line => line.trim())
    .filter(Boolean);
  return collapseTranscriptArtifacts(lines).join('\n').trim();
}

interface TranscriptWord {
  normalized: string;
  start: number;
}

function findTranscriptOverlap(
  leftText: string,
  rightText: string
): { leftStart: number; rightStart: number } | null {
  const left = transcriptWords(leftText);
  const right = transcriptWords(rightText);
  const leftStart = Math.max(0, left.length - 80);
  const rightEnd = Math.min(right.length, 50);
  let best:
    | {
        score: number;
        leftStart: number;
        rightStart: number;
      }
    | undefined;

  for (let leftIndex = leftStart; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < rightEnd; rightIndex += 1) {
      let length = 0;
      let exact = 0;
      while (
        leftIndex + length < left.length &&
        rightIndex + length < right.length &&
        similarTranscriptWord(
          left[leftIndex + length].normalized,
          right[rightIndex + length].normalized
        )
      ) {
        if (left[leftIndex + length].normalized === right[rightIndex + length].normalized) {
          exact += 1;
        }
        length += 1;
      }
      const matchedCharacters = left
        .slice(leftIndex, leftIndex + length)
        .reduce((total, word) => total + word.normalized.length, 0);
      const leftTail = left.length - (leftIndex + length);
      const rightPrefix = rightIndex;
      const boundaryPair =
        length === 2 && exact === 2 && matchedCharacters >= 5 && leftTail <= 2 && rightPrefix <= 2;
      if ((length < 3 && !boundaryPair) || exact < 2) continue;
      if (length === 3 && matchedCharacters < 12) continue;

      if (leftTail > 35 || rightPrefix > 35) continue;
      const score = length * 100 + exact * 10 - leftTail * 2 - rightPrefix;
      if (!best || score > best.score) {
        best = {
          score,
          leftStart: left[leftIndex].start,
          rightStart: right[rightIndex].start
        };
      }
    }
  }
  return best
    ? { leftStart: best.leftStart, rightStart: best.rightStart }
    : findCharacterOverlap(leftText, rightText);
}

function findCharacterOverlap(
  leftText: string,
  rightText: string
): { leftStart: number; rightStart: number } | null {
  const left = transcriptCharacters(leftText);
  const right = transcriptCharacters(rightText);
  const leftStart = Math.max(0, left.length - 240);
  const rightEnd = Math.min(right.length, 160);
  let best:
    | {
        score: number;
        leftStart: number;
        rightStart: number;
      }
    | undefined;

  for (let leftIndex = leftStart; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < rightEnd; rightIndex += 1) {
      let length = 0;
      while (
        leftIndex + length < left.length &&
        rightIndex + length < right.length &&
        left[leftIndex + length].normalized === right[rightIndex + length].normalized
      ) {
        length += 1;
      }
      if (length < 8) continue;
      const leftTail = left.length - (leftIndex + length);
      if (leftTail > 100 || rightIndex > 100) continue;
      const score = length * 10 - leftTail * 2 - rightIndex;
      if (!best || score > best.score) {
        best = {
          score,
          leftStart: left[leftIndex].start,
          rightStart: right[rightIndex].start
        };
      }
    }
  }
  return best ? { leftStart: best.leftStart, rightStart: best.rightStart } : null;
}

function transcriptWords(text: string): TranscriptWord[] {
  const output: TranscriptWord[] = [];
  const pattern = /[\p{L}\p{M}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    output.push({
      normalized: match[0].normalize('NFKC').toLocaleLowerCase(),
      start: match.index
    });
  }
  return output;
}

function transcriptCharacters(text: string): TranscriptWord[] {
  const output: TranscriptWord[] = [];
  const pattern = /[\p{L}\p{M}\p{N}]/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    for (const normalized of Array.from(match[0].normalize('NFKC').toLocaleLowerCase())) {
      output.push({ normalized, start: match.index });
    }
  }
  return output;
}

function similarTranscriptWord(left: string, right: string): boolean {
  if (left === right) return true;
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  if (Math.min(leftPoints.length, rightPoints.length) < 5) return false;
  const maxEdits = Math.min(leftPoints.length, rightPoints.length) >= 8 ? 2 : 1;
  if (Math.abs(leftPoints.length - rightPoints.length) > maxEdits) return false;

  let previous = Array.from({ length: rightPoints.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= leftPoints.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= rightPoints.length; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1] +
        (leftPoints[leftIndex - 1] === rightPoints[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution
      );
    }
    previous = current;
  }
  return previous[rightPoints.length] <= maxEdits;
}

function joinTranscriptText(left: string, right: string): string {
  if (!right) return left;
  if (!left) return right;
  const compactScript =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]$/u;
  if (
    compactScript.test(left) &&
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(
      right
    )
  ) {
    return `${left}${right}`;
  }
  return /^[,.;:!?…।॥؟。！？)\]}]/u.test(right) ? `${left}${right}` : `${left} ${right}`;
}

function requestedOrDetectedLanguage(requested: string, detected: string | null): string | null {
  return requested && requested !== 'auto' ? requested : detected;
}

function appendDiagnostics(left: string, right: string): string {
  return `${left}\n${right}`.trim().slice(-12_000);
}

/**
 * Removes two decoder artifacts without rewriting normal speech:
 * - residual hallucination loops with the same set of words;
 * - a line cut in the middle of its final word immediately before Whisper
 *   emits the corrected, longer segment (for example `resul` / `result ...`).
 *
 * Requiring a strict continuation of the final word avoids collapsing real
 * sentences that merely begin with the same complete phrase.
 */
export function collapseTranscriptArtifacts(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out.at(-1);
    if (!previous) {
      out.push(line);
      continue;
    }

    const key = wordSetKey(line);
    if (key && key === wordSetKey(previous)) continue;
    if (isTruncatedPrefix(previous, line)) {
      out[out.length - 1] = line;
      continue;
    }
    if (isTruncatedPrefix(line, previous)) continue;
    out.push(line);
  }
  return out;
}

function wordSetKey(line: string): string {
  return Array.from(new Set(words(line)))
    .sort()
    .join(' ');
}

function isTruncatedPrefix(shorter: string, longer: string): boolean {
  if (/[.!?…।॥؟。！？]$/u.test(shorter.trim())) return false;
  const shortWords = words(shorter);
  const longWords = words(longer);
  if (shortWords.length < 3 || longWords.length <= shortWords.length) return false;

  const last = shortWords.length - 1;
  for (let index = 0; index < last; index += 1) {
    if (shortWords[index] !== longWords[index]) return false;
  }

  return (
    longWords[last].length > shortWords[last].length && longWords[last].startsWith(shortWords[last])
  );
}

function words(line: string): string[] {
  return (
    line
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  );
}
