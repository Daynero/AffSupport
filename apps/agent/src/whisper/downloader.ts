import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TranscriptionModelInfo } from '@video-compressor/shared';
import { downloadedModelPath, MODEL_DESCRIPTOR, modelPresent } from './tools.js';

/**
 * Downloads the large speech model on demand into a writable location, so the
 * installer stays small. Streams to a `.part` file, verifies SHA-256, then
 * atomically renames into place. Progress is pushed through `notify`.
 */
export class ModelDownloader {
  private downloading = false;
  private downloadedBytes = 0;
  private progress: number | null = null;
  private error: string | null = null;
  private controller: AbortController | null = null;

  constructor(
    private notify: () => void,
    private onComplete: () => void
  ) {}

  status(): TranscriptionModelInfo {
    return {
      present: modelPresent(),
      downloading: this.downloading,
      progress: this.progress,
      sizeBytes: MODEL_DESCRIPTOR.sizeBytes,
      downloadedBytes: this.downloadedBytes,
      label: MODEL_DESCRIPTOR.label,
      error: this.error
    };
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** Idempotent: a no-op if the model already exists or a download is running. */
  async start(): Promise<void> {
    if (this.downloading || modelPresent()) return;
    this.downloading = true;
    this.error = null;
    this.downloadedBytes = 0;
    this.progress = 0;
    this.notify();

    const target = downloadedModelPath();
    const partial = `${target}.part`;
    this.controller = new AbortController();
    try {
      await mkdir(path.dirname(target), { recursive: true });
      const response = await fetch(MODEL_DESCRIPTOR.url, { signal: this.controller.signal });
      if (!response.ok || !response.body) {
        throw new Error(`Download failed (HTTP ${response.status}).`);
      }
      const total = Number(response.headers.get('content-length')) || MODEL_DESCRIPTOR.sizeBytes;
      let lastPercent = -1;
      const counter = new Transform({
        transform: (chunk, _enc, callback) => {
          this.downloadedBytes += chunk.length;
          const percent = Math.min(99, Math.floor((this.downloadedBytes / total) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            this.progress = percent;
            this.notify();
          }
          callback(null, chunk);
        }
      });
      // response.body is a web ReadableStream; the DOM/node type overlap is
      // imperfect, so bridge it explicitly to a Node stream.
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(source, counter, createWriteStream(partial));

      const digest = await sha256(partial);
      if (digest !== MODEL_DESCRIPTOR.sha256) {
        throw new Error('The downloaded model failed its integrity check.');
      }
      await rename(partial, target);
      this.progress = 100;
      this.downloading = false;
      this.notify();
      this.onComplete();
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      this.downloading = false;
      this.progress = null;
      this.error =
        this.controller?.signal.aborted === true
          ? null // user cancelled — not an error worth surfacing
          : error instanceof Error
            ? error.message
            : 'The model could not be downloaded.';
      this.notify();
    } finally {
      this.controller = null;
    }
  }
}

async function sha256(filePath: string): Promise<string> {
  await stat(filePath); // surface a clear error if the file vanished
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}
