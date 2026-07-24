import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ffmpegPath, probeMedia } from '../apps/agent/src/ffmpeg/tools.js';
import { mediaMimeType } from '../apps/agent/src/transcription/media.js';
import { MediaPreviewManager } from '../apps/agent/src/transcription/media-preview.js';

const execFileAsync = promisify(execFile);
const runReal = process.env.RUN_REAL_MEDIA_SMOKE === '1';

describe.runIf(runReal)('local media preview smoke', () => {
  it('creates a cached H.264/AAC proxy for an unsupported MKV and keeps it seekable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-preview-'));
    const sourcePath = path.join(dir, 'fixture.mkv');
    const manager = new MediaPreviewManager(path.join(dir, 'cache'));
    try {
      await execFileAsync(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=24:duration=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:v',
        'mpeg4',
        '-c:a',
        'pcm_s16le',
        '-y',
        sourcePath
      ]);
      const source = {
        path: sourcePath,
        fileName: 'fixture.mkv',
        mimeType: mediaMimeType('fixture.mkv'),
        durationSeconds: 1
      };
      expect((await manager.status('job', source)).variant).toBe('proxy');
      await manager.prepare('job', source);
      let status = await manager.status('job', source);
      const deadline = Date.now() + 20_000;
      while (status.state === 'preparing' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        status = await manager.status('job', source);
      }
      expect(status).toMatchObject({ state: 'ready', variant: 'proxy', progress: 100 });
      const prepared = await manager.prepared('job', source);
      expect(prepared?.mimeType).toBe('video/mp4');
      expect((await stat(prepared!.path)).size).toBeGreaterThan(0);
      const media = await probeMedia(prepared!.path);
      expect(media).toMatchObject({ codec: 'h264', audioCodec: 'aac', hasAudio: true });
      expect(media.height).toBeLessThanOrEqual(720);
    } finally {
      await manager.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
