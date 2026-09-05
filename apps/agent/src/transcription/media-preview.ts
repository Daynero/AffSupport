import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { activeThreadBudget, spawnTracked } from '../power/spawn.js';
import os from 'node:os';

/** No progress line for this long and the transcode is treated as stuck. */
const PREVIEW_STALL_TIMEOUT_MS = 2 * 60_000;
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { replaceFile } from '../files/replace-file.js';
import path from 'node:path';
import type { TranscriptionMediaPreview } from '@video-compressor/shared';
import { ffmpegPath, probeMedia } from '../ffmpeg/tools.js';

export interface PreviewSource {
  path: string;
  fileName: string;
  mimeType: string;
  durationSeconds: number | null;
}

export interface PreparedMedia {
  path: string;
  fileName: string;
  mimeType: string;
}

interface PreviewEntry {
  sourceKey: string;
  status: TranscriptionMediaPreview;
  outputPath: string | null;
  child: ChildProcessWithoutNullStreams | null;
  promise: Promise<TranscriptionMediaPreview> | null;
  /** A stop that landed while the transcode was still waiting for its turn. */
  cancelled: boolean;
}

const ORIGINAL_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const ORIGINAL_AUDIO_CODECS = new Set([
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'pcm_s16le',
  'pcm_s24le',
  'flac'
]);
const ORIGINAL_VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const ORIGINAL_AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.flac',
  '.ogg',
  '.oga',
  '.opus'
]);

/**
 * Manages browser playback assets without exposing source paths. Browser-safe
 * inputs stream untouched; unsupported containers/codecs are converted once to
 * a cached H.264/AAC MP4 under Application Support. All state is process-local
 * and ffmpeg output is intentionally not logged because it can contain paths.
 */
export class MediaPreviewManager {
  /** The transcode in progress, so the next one queues behind it. */
  private transcodeTail: Promise<void> = Promise.resolve();
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly pendingEntries = new Map<string, Promise<PreviewEntry>>();

  constructor(private readonly cacheDir: string) {}

  async status(jobId: string, source: PreviewSource): Promise<TranscriptionMediaPreview> {
    const entry = await this.entry(jobId, source);
    return { ...entry.status };
  }

  async prepare(jobId: string, source: PreviewSource): Promise<TranscriptionMediaPreview> {
    const entry = await this.entry(jobId, source);
    if (entry.status.state === 'ready' || entry.status.state === 'preparing') {
      return { ...entry.status };
    }
    if (entry.status.variant === 'original') {
      entry.status = { ...entry.status, state: 'ready', progress: 100, error: null };
      return { ...entry.status };
    }

    entry.status = {
      ...entry.status,
      state: 'preparing',
      variant: 'proxy',
      progress: 0,
      error: null,
      mimeType: entry.status.hasVideo ? 'video/mp4' : 'audio/mp4'
    };
    entry.cancelled = false;
    // One transcode at a time. Two open viewers used to mean two x264 encodes beside the
    // transcription; the second waits for the first, and its status stays "preparing" —
    // which is exactly what it is doing.
    const turn = this.transcodeTail.catch(() => undefined);
    const run = turn.then(() => this.transcode(jobId, source, entry));
    this.transcodeTail = run.then(
      () => undefined,
      () => undefined
    );
    entry.promise = run.catch(() => {
      entry.child = null;
      entry.promise = null;
      entry.status = {
        ...entry.status,
        state: 'failed',
        progress: null,
        error: 'PREVIEW_FAILED'
      };
      return { ...entry.status };
    });
    void entry.promise;
    return { ...entry.status };
  }

  /**
   * Stops the proxy transcode for one job.
   *
   * Keyed on the child rather than on `status.state`: the status is set before
   * the transcode starts and rewritten after it ends, so a stop that landed in
   * either gap was silently dropped and left a full-speed FFmpeg running behind
   * a job the user had already stopped.
   */
  cancel(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    // Waiting for its turn behind another transcode there is no child yet; the flag is
    // read the moment the turn comes, so the stop is honoured instead of starting a full
    // encode the person had already stopped.
    entry.cancelled = true;
    entry.child?.kill('SIGTERM');
  }

  async prepared(jobId: string, source: PreviewSource): Promise<PreparedMedia | null> {
    const entry = await this.entry(jobId, source);
    if (entry.status.state !== 'ready') return null;
    if (entry.status.variant === 'original') {
      return { path: source.path, fileName: source.fileName, mimeType: source.mimeType };
    }
    if (!entry.outputPath) return null;
    try {
      await access(entry.outputPath);
      return {
        path: entry.outputPath,
        fileName: `${path.parse(source.fileName).name}-soty-preview.mp4`,
        mimeType: entry.status.mimeType ?? 'video/mp4'
      };
    } catch {
      return null;
    }
  }

  async remove(jobId: string): Promise<void> {
    const entry = this.entries.get(jobId);
    entry?.child?.kill('SIGTERM');
    this.entries.delete(jobId);
    if (entry?.outputPath) await rm(entry.outputPath, { force: true }).catch(() => {});
  }

  /**
   * Removes proxies of jobs that no longer exist.
   *
   * A proxy is a 720p re-encode of the person's own creative, written for the player and
   * removed with its job — unless the process was killed first, in which case it sat in the
   * cache directory with no owner for as long as the application stayed installed.
   */
  async sweepOrphans(knownJobIds: ReadonlySet<string>): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.cacheDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      // `<jobId>-<digest>.mp4`, or a `.part` a transcode never finished.
      const jobId = entry.replace(/\.mp4(\.part)?$/u, '').replace(/-[0-9a-f]{16}$/u, '');
      if (jobId !== entry && knownJobIds.has(jobId) && !entry.endsWith('.part')) continue;
      await rm(path.join(this.cacheDir, entry), { force: true }).catch(() => {});
      removed += 1;
    }
    return removed;
  }

  async close(): Promise<void> {
    for (const entry of this.entries.values()) entry.child?.kill('SIGTERM');
    await Promise.allSettled(
      [...this.entries.values()].map(entry => entry.promise).filter(Boolean)
    );
  }

  private entry(jobId: string, source: PreviewSource): Promise<PreviewEntry> {
    // Two callers arriving while the probe is still running share one entry; each making
    // its own used to start two transcodes and delete the first one's output.
    const pending = this.pendingEntries.get(jobId);
    if (pending) return pending;
    const creating = this.createEntry(jobId, source).finally(() =>
      this.pendingEntries.delete(jobId)
    );
    this.pendingEntries.set(jobId, creating);
    return creating;
  }

  private async createEntry(jobId: string, source: PreviewSource): Promise<PreviewEntry> {
    const sourceStat = await stat(source.path);
    const sourceKey = `${source.path}\0${sourceStat.size}\0${sourceStat.mtimeMs}`;
    const existing = this.entries.get(jobId);
    if (existing?.sourceKey === sourceKey) return existing;
    if (existing) await this.remove(jobId);

    const media = await probeMedia(source.path);
    const hasVideo = media.width !== null && media.height !== null && media.codec !== null;
    const original = browserCompatible(
      source.fileName,
      hasVideo,
      media.codec,
      media.audioCodec,
      media.hasAudio
    );
    const outputPath = original ? null : this.cachePath(jobId, sourceKey);
    const readyCached = outputPath ? await fileExists(outputPath) : false;
    const entry: PreviewEntry = {
      sourceKey,
      status: {
        state: original || readyCached ? 'ready' : 'checking',
        variant: original ? 'original' : 'proxy',
        progress: original || readyCached ? 100 : null,
        hasVideo,
        mimeType: original ? source.mimeType : hasVideo ? 'video/mp4' : 'audio/mp4',
        error: null
      },
      outputPath,
      child: null,
      promise: null,
      cancelled: false
    };
    this.entries.set(jobId, entry);
    return entry;
  }

  private cachePath(jobId: string, sourceKey: string): string {
    const safeId = jobId.replace(/[^A-Za-z0-9._-]/gu, '');
    const digest = createHash('sha256').update(sourceKey).digest('hex').slice(0, 16);
    return path.join(this.cacheDir, `${safeId}-${digest}.mp4`);
  }

  private async transcode(
    jobId: string,
    source: PreviewSource,
    entry: PreviewEntry
  ): Promise<TranscriptionMediaPreview> {
    const output = entry.outputPath;
    if (!output) return { ...entry.status };
    if (entry.cancelled) {
      entry.status = { ...entry.status, state: 'checking', progress: null, error: null };
      return { ...entry.status };
    }
    const partial = `${output}.part`;
    await mkdir(this.cacheDir, { recursive: true });
    await rm(partial, { force: true }).catch(() => {});
    const hasVideo = entry.status.hasVideo === true;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      source.path,
      ...(hasVideo
        ? [
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-vf',
            "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
            '-c:v',
            'libx264',
            // A preview, not a deliverable: the cheapest preset that still looks like the
            // source at 720p, on a machine that is probably also running whisper.
            '-preset',
            'ultrafast',
            '-crf',
            '23',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '160k'
          ]
        : ['-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k']),
      // Bounded like every other managed encode; without it x264 takes every core beside
      // the transcription that is already running.
      '-threads',
      String(activeThreadBudget() ?? Math.max(2, Math.min(4, os.cpus().length - 2))),
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      '-y',
      '-f',
      'mp4',
      partial
    ];

    const child = spawnTracked(ffmpegPath, args, {
      toolId: 'transcription-preview'
    }) as ChildProcessWithoutNullStreams;
    entry.child = child;
    // A proxy transcode that stops reporting has stopped working: its source is on a volume
    // that went away, or the demuxer is spinning. Without this the player would show
    // "preparing" for as long as the modal stayed open.
    let stallTimer: NodeJS.Timeout | null = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => child.kill('SIGKILL'), PREVIEW_STALL_TIMEOUT_MS);
      stallTimer.unref();
    };
    armStall();
    child.once('close', () => {
      if (stallTimer) clearTimeout(stallTimer);
    });
    let progressBuffer = '';
    child.stdout.on('data', chunk => {
      armStall();
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/u);
      progressBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const [key, raw] = line.split('=', 2);
        if (key === 'out_time_us') {
          const duration = source.durationSeconds;
          const outSeconds = Number(raw) / 1_000_000;
          if (duration && Number.isFinite(outSeconds)) {
            entry.status.progress = Math.min(99, Math.max(0, (outSeconds / duration) * 100));
          }
        } else if (key === 'progress' && raw === 'end') {
          entry.status.progress = 100;
        }
      }
    });
    // Consume but never retain/log stderr: ffmpeg diagnostics can include the
    // private source path.
    child.stderr.on('data', () => {});

    const result = await new Promise<{ code: number | null; aborted: boolean }>(resolve => {
      let aborted = false;
      child.once('error', () => resolve({ code: null, aborted: false }));
      child.once('exit', (_code, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') aborted = true;
      });
      child.once('close', code => resolve({ code, aborted }));
    });
    entry.child = null;

    if (result.code === 0) {
      try {
        await replaceFile(partial, output);
        await chmod(output, 0o600);
        entry.status = { ...entry.status, state: 'ready', progress: 100, error: null };
      } catch {
        await rm(partial, { force: true }).catch(() => {});
        entry.status = {
          ...entry.status,
          state: 'failed',
          progress: null,
          error: 'PREVIEW_FAILED'
        };
      }
    } else {
      await rm(partial, { force: true }).catch(() => {});
      entry.status = {
        ...entry.status,
        state: result.aborted ? 'checking' : 'failed',
        progress: null,
        error: result.aborted ? null : 'PREVIEW_FAILED'
      };
    }
    entry.promise = null;
    // Keep the map entry only if the job has not since been removed/replaced.
    if (this.entries.get(jobId) !== entry) await rm(output, { force: true }).catch(() => {});
    return { ...entry.status };
  }
}

export function browserCompatible(
  fileName: string,
  hasVideo: boolean,
  videoCodec: string | null,
  audioCodec: string | null,
  hasAudio: boolean
): boolean {
  const extension = path.extname(fileName).toLowerCase();
  if (hasVideo) {
    if (!ORIGINAL_VIDEO_EXTENSIONS.has(extension) || !videoCodec) return false;
    if (!ORIGINAL_VIDEO_CODECS.has(videoCodec.toLowerCase())) return false;
    return (
      !hasAudio || (audioCodec !== null && ORIGINAL_AUDIO_CODECS.has(audioCodec.toLowerCase()))
    );
  }
  return (
    ORIGINAL_AUDIO_EXTENSIONS.has(extension) &&
    audioCodec !== null &&
    ORIGINAL_AUDIO_CODECS.has(audioCodec.toLowerCase())
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
