import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
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
  private readonly entries = new Map<string, PreviewEntry>();

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
    entry.promise = this.transcode(jobId, source, entry).catch(() => {
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

  cancel(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry?.child || entry.status.state !== 'preparing') return;
    entry.child.kill('SIGTERM');
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
        fileName: `${path.parse(source.fileName).name}-wishly-preview.mp4`,
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

  async close(): Promise<void> {
    for (const entry of this.entries.values()) entry.child?.kill('SIGTERM');
    await Promise.allSettled(
      [...this.entries.values()].map(entry => entry.promise).filter(Boolean)
    );
  }

  private async entry(jobId: string, source: PreviewSource): Promise<PreviewEntry> {
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
      promise: null
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
            '-preset',
            'veryfast',
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

    const child = spawn(ffmpegPath, args, { shell: false });
    entry.child = child;
    let progressBuffer = '';
    child.stdout.on('data', chunk => {
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
        await rename(partial, output);
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
