import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { writeStubTool } from './support/stub-tools/index.js';

let directory = '';
let behaviourFile = '';
let probes: typeof import('../apps/agent/src/ffmpeg/tools.js');

async function respond(value: unknown) {
  await writeFile(behaviourFile, JSON.stringify({ stdoutText: JSON.stringify(value) }));
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'soty-ffprobe-contract-'));
  behaviourFile = path.join(directory, 'behaviour.json');
  process.env.FFPROBE_PATH = await writeStubTool(directory, 'ffprobe', {
    behaviourFile,
    durationMs: 1
  });
  vi.resetModules();
  probes = await import('../apps/agent/src/ffmpeg/tools.js');
});

afterAll(async () => {
  delete process.env.FFPROBE_PATH;
  if (directory) await removeTemporaryDirectory(directory);
});

describe('FFprobe result contracts', () => {
  it('keeps a video-only result usable when optional metadata is malformed', async () => {
    await respond({
      streams: [
        {
          codec_type: 'video',
          width: 320,
          height: 180,
          codec_name: 'h264',
          avg_frame_rate: '0/0',
          r_frame_rate: 'bad',
          tags: { rotate: '90' }
        }
      ],
      format: { duration: '12', bit_rate: '900000', format_name: 'mp4' }
    });
    const media = await probes.probeMedia('fixture.mp4');
    expect(media).toMatchObject({
      duration: 12,
      width: 180,
      height: 320,
      frameRate: null,
      bitrate: 900000,
      hasAudio: false
    });
  });

  it('uses the last video packet when it extends past the container duration', async () => {
    await respond({
      format: { duration: '10' },
      packets: [null, {}, { pts_time: 'invalid' }, { pts_time: '9.9', duration_time: '0.2' }]
    });
    expect(await probes.concatSegmentDuration('fixture.mp4')).toBeCloseTo(10.1);
    await respond({ format: { duration: '10' }, packets: [] });
    expect(await probes.concatSegmentDuration('fixture.mp4')).toBeNull();
  });

  it('returns no image for incomplete geometry and accepts rotated images', async () => {
    await respond({ streams: [{ width: 100, codec_name: 'png' }] });
    expect(await probes.probeImage('fixture.png')).toBeNull();
    await respond({
      streams: [
        {
          width: 100,
          height: 50,
          codec_name: 'png',
          nb_frames: '1',
          side_data_list: [{ rotation: 270 }]
        }
      ]
    });
    expect(await probes.probeImage('fixture.png')).toEqual({
      width: 50,
      height: 100,
      codec: 'png',
      frames: 1
    });
  });

  it('bounds a stalled duration probe and tolerates a non-JSON probe response', async () => {
    await writeFile(behaviourFile, JSON.stringify({ hang: true, burnFuseMs: 1_000 }));
    expect(await probes.probeDuration('fixture.mp4', 20)).toBeNull();
    await writeFile(behaviourFile, JSON.stringify({ stdoutText: 'not json' }));
    expect(await probes.probeMedia('fixture.mp4')).toMatchObject({
      duration: null,
      hasAudio: false
    });
  });

  it('reports a probe executable that cannot be started', async () => {
    await expect(probes.probeMedia('fixture.mp4', '')).rejects.toMatchObject({
      code: 'MEDIA_TOOL_UNAVAILABLE'
    });
  });
});
