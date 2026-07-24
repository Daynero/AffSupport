import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TranscriptionModelInfo } from '@video-compressor/shared';

/** The minimum a model needs to be fetched + verified on demand. */
export interface DownloadableModelDescriptor {
  label: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

class ArtifactValidationError extends Error {}

// Large Hugging Face/Xet artifacts can arrive as a series of short-lived
// responses on some networks. Thirty-two bounded reconnects still surface a
// persistent outage, but let a 2.5–3.1 GB model finish in one user-initiated
// install even when the CDN terminates every few hundred megabytes.
const MAX_NETWORK_ATTEMPTS = 32;

/**
 * Downloads a large model on demand into a writable location, so the installer
 * stays small. Streams to a `.part` file, verifies SHA-256, then atomically
 * renames into place. Progress is pushed through `notify`. Generic over the
 * model so the same logic serves the Whisper speech model and the TranslateGemma
 * translation model.
 */
export class ModelDownloader {
  private downloading = false;
  private downloadedBytes = 0;
  private progress: number | null = null;
  private error: string | null = null;
  private controller: AbortController | null = null;
  private downloadBatchId: string | null = null;

  constructor(
    private descriptor: DownloadableModelDescriptor,
    private targetPath: () => string,
    private isPresent: () => boolean,
    private notify: () => void,
    private onComplete: () => void | Promise<void>,
    /**
     * Optional post-verification installer (for the llama.cpp tarball). It runs
     * only after the archive itself has been atomically renamed into place.
     */
    private finalize?: (verifiedPath: string) => Promise<void>
  ) {
    // Surface resumable bytes immediately after an agent restart instead of
    // showing 0 until Retry is clicked. Any race here is harmless: start()
    // performs the authoritative async stat again before opening the stream.
    if (!this.isPresent()) {
      try {
        this.downloadedBytes = statSync(`${this.targetPath()}.part`).size;
        this.progress = downloadPercent(this.downloadedBytes, this.descriptor.sizeBytes);
      } catch {
        // No partial download yet.
      }
    }
  }

  status(): TranscriptionModelInfo {
    return {
      present: this.isPresent(),
      downloading: this.downloading,
      progress: this.progress,
      sizeBytes: this.descriptor.sizeBytes,
      downloadedBytes: this.downloadedBytes,
      downloadBatchId: this.downloadBatchId,
      label: this.descriptor.label,
      error: this.error
    };
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** Idempotent: a no-op if the model already exists or a download is running. */
  async start(downloadBatchId?: string): Promise<void> {
    if (this.downloading || this.isPresent()) return;
    this.downloadBatchId = downloadBatchId ?? null;
    if (!this.descriptor.url || !this.descriptor.sha256) {
      // No pinned source yet (e.g. the translator model artifact is not
      // configured). Surface a clear, actionable error instead of failing an
      // HTTP request to an empty URL.
      this.error = 'MODEL_SOURCE_NOT_CONFIGURED';
      this.notify();
      return;
    }
    this.downloading = true;
    this.error = null;

    const target = this.targetPath();
    const partial = `${target}.part`;
    this.controller = new AbortController();
    try {
      await mkdir(path.dirname(target), { recursive: true });
      let existingBytes = await fileSize(partial);
      if (this.descriptor.sizeBytes > 0 && existingBytes > this.descriptor.sizeBytes) {
        await rm(partial, { force: true });
        existingBytes = 0;
      }
      this.downloadedBytes = existingBytes;
      this.progress = downloadPercent(existingBytes, this.descriptor.sizeBytes);
      this.notify();

      let lastError: unknown = null;
      for (let attempt = 0; attempt < MAX_NETWORK_ATTEMPTS; attempt += 1) {
        try {
          await this.downloadAttempt(partial);
          lastError = null;
          break;
        } catch (error) {
          if (this.controller.signal.aborted) throw error;
          lastError = error;
          if (attempt === MAX_NETWORK_ATTEMPTS - 1) break;
          // Keep the exact `.part` bytes and reconnect with HTTP Range. Large
          // Hugging Face/Xet responses can be terminated mid-stream; deleting
          // 1–2 GB here made installation appear permanently broken.
          await abortableDelay(Math.min(4_000, 400 * 2 ** attempt), this.controller.signal);
        }
      }
      if (lastError) throw lastError;

      const downloaded = (await stat(partial)).size;
      if (this.descriptor.sizeBytes > 0 && downloaded !== this.descriptor.sizeBytes) {
        throw new ArtifactValidationError(
          `The downloaded artifact has an unexpected size (${downloaded} bytes).`
        );
      }
      const digest = await sha256(partial);
      if (digest !== this.descriptor.sha256.toLowerCase()) {
        throw new ArtifactValidationError('The downloaded model failed its integrity check.');
      }
      await rename(partial, target);
      await this.finalize?.(target);
      if (!this.isPresent()) {
        throw new Error('The downloaded artifact could not be installed.');
      }
      this.progress = 100;
      this.downloading = false;
      this.notify();
      await this.onComplete();
    } catch (error) {
      const aborted = this.controller?.signal.aborted === true;
      // Explicit Cancel and corrupt/incorrect artifacts must not leave bytes
      // behind. A transient network/HTTP error intentionally keeps `.part` so
      // the user's Retry resumes instead of restarting a multi-gigabyte file.
      if (aborted || error instanceof ArtifactValidationError) {
        await rm(partial, { force: true }).catch(() => {});
        this.downloadedBytes = 0;
      }
      // A finalizer may have failed after the verified archive was renamed.
      // Removing this exact target makes Retry deterministic.
      if (this.finalize) {
        await rm(target, { force: true }).catch(() => {});
        this.downloadedBytes = 0;
      }
      this.downloading = false;
      this.progress = null;
      this.error = aborted
        ? null
        : error instanceof Error
          ? error.message
          : 'The model could not be downloaded.';
      this.notify();
    } finally {
      this.controller = null;
    }
  }

  private async downloadAttempt(partial: string): Promise<void> {
    let offset = await fileSize(partial);
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
    const response = await fetch(this.descriptor.url, {
      signal: this.controller?.signal,
      headers
    });
    if (!response.ok || !response.body) {
      if (
        response.status === 416 &&
        this.descriptor.sizeBytes > 0 &&
        offset === this.descriptor.sizeBytes
      ) {
        return;
      }
      throw new Error(`Download failed (HTTP ${response.status}).`);
    }

    // A server may ignore Range and return 200. Restart this attempt safely
    // rather than appending the whole artifact to the existing partial.
    const appending = offset > 0 && response.status === 206;
    if (!appending) offset = 0;
    const contentRange = response.headers.get('content-range');
    if (appending && contentRange && !contentRange.startsWith(`bytes ${offset}-`)) {
      throw new Error('The model server returned an invalid byte range.');
    }
    const rangeTotal = Number(/\/(\d+)\s*$/u.exec(contentRange ?? '')?.[1]);
    const contentLength = Number(response.headers.get('content-length'));
    const total =
      this.descriptor.sizeBytes ||
      (Number.isFinite(rangeTotal) && rangeTotal > 0
        ? rangeTotal
        : Number.isFinite(contentLength) && contentLength > 0
          ? offset + contentLength
          : 0);
    this.downloadedBytes = offset;
    let lastPercent = downloadPercent(offset, total);
    this.progress = lastPercent;
    this.notify();

    const counter = new Transform({
      transform: (chunk, _enc, callback) => {
        this.downloadedBytes += chunk.length;
        const percent = downloadPercent(this.downloadedBytes, total);
        if (percent !== lastPercent) {
          lastPercent = percent;
          this.progress = percent;
          this.notify();
        }
        callback(null, chunk);
      }
    });
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(source, counter, createWriteStream(partial, { flags: appending ? 'a' : 'w' }));
  }
}

async function sha256(filePath: string): Promise<string> {
  await stat(filePath);
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

function downloadPercent(downloaded: number, total: number): number | null {
  return total > 0 ? Math.min(99, Math.floor((downloaded / total) * 100)) : null;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}
