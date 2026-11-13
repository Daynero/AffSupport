import { removeTemporaryDirectory } from './support/temp-dir';
import { copyFile, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as runner from '../apps/agent/src/stitcher/run';
import {
  createRestitchDelegate,
  parseRestitchOptions
} from '../apps/agent/src/team-bridge/restitch';
import { PreparedBodyCache } from '../apps/agent/src/stitcher/body-cache';
import { RESTITCH_DETECTOR_VERSION } from '@video-compressor/shared';
import { HevcCompatibility } from '../apps/agent/src/stitcher/hevc-normalize';
import { runTool } from '../apps/agent/src/stitcher/run';
import { ffmpegPath, ffprobePath } from '../apps/agent/src/ffmpeg/tools';
import { requireBinaries, describeRequiring } from './support/requires';
const engines = await requireBinaries(ffmpegPath, ffprobePath);
const fixtures = path.resolve('tests/fixtures/hevc-compatibility');
let root = '';
let converter: HevcCompatibility;
const checksum = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
async function tool(args: string[], probe = false) {
  const result = await runTool(probe ? ffprobePath : ffmpegPath, args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}
async function prepare(name: string, input = path.join(fixtures, `${name}.mp4`)) {
  const workspace = await mkdtemp(path.join(root, 'consumer-'));
  const source = path.join(workspace, 'original.mp4');
  await copyFile(input, source);
  const before = await checksum(source);
  const stages: string[] = [];
  const result = await converter.prepare({
    sourceFile: source,
    workspace,
    runId: crypto.randomUUID(),
    signal: new AbortController().signal,
    threads: 1,
    onStage: stage => stages.push(stage)
  });
  expect(await checksum(source)).toBe(before);
  expect(result.profile).toMatchObject({
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    colorRange: 'tv',
    variableFrameRate: false
  });
  expect(result.sourceIdentity).toMatch(/^sha256:[a-f0-9]{64}:\d+\|hevc-h264-sdr-v1$/u);
  return { ...result, workspace, source, stages };
}
async function pixels(file: string, workspace: string) {
  const output = path.join(workspace, 'pixels.rgb');
  await tool([
    '-v',
    'error',
    '-y',
    '-i',
    file,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    output
  ]);
  return readFile(output);
}
// Independent neutral-light reference: BT.2100 EOTF, Mobius shoulder, BT.709 OETF.
// Each sample is well inside a constant patch, excluding chroma/codec boundaries.
function reference(code: number, transfer: 'pq' | 'hlg') {
  const v = (code - 64) / 876;
  const linear =
    transfer === 'pq'
      ? 100 *
        (Math.max(v ** (1 / 78.84375) - 0.8359375, 0) /
          (18.8515625 - 18.6875 * v ** (1 / 78.84375))) **
          (1 / 0.1593017578125)
      : 10 * ((Math.exp((v - 0.559910729529562) / 0.17883277) + 0.28466892) / 12) ** 1.2;
  const j = 0.3,
    peak = 10;
  const a = (-j * j * (peak - 1)) / (j * j - 2 * j + peak);
  const b = (j * j - 2 * j * peak + peak) / (peak - 1);
  const mapped = linear <= j ? linear : (((b + j) ** 2 / (b - a)) * (linear + a)) / (linear + b);
  return 255 * (mapped < 0.018 ? 4.5 * mapped : 1.099 * Math.min(mapped, 1) ** 0.45 - 0.099);
}
describeRequiring(engines, 'native HEVC catalog compatibility', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'soty-hevc-native-'));
    converter = new HevcCompatibility({ root });
  });
  afterAll(async () => {
    await removeTemporaryDirectory(root);
  });
  it('normalizes Main 8-bit hvc1 and reuses only verified output after a restart', async () => {
    const first = await prepare('main8', path.resolve('tests/fixtures/stitcher-hevc-hvc1.mp4'));
    expect(first.profile).toMatchObject({ width: 320, height: 320, hasAudio: false });
    expect(first.stages).toEqual(['converting', 'verifying']);
    converter = new HevcCompatibility({ root });
    const second = await prepare('main8', path.resolve('tests/fixtures/stitcher-hevc-hvc1.mp4'));
    expect(second.fromCache).toBe(true);
    expect(second.stages).toEqual([]);
    expect(second.sourceIdentity).toBe(first.sourceIdentity);
  }, 30_000);
  it('normalizes Main10 SDR with audio, and repairs VFR into a constant cadence', async () => {
    const sdr = await prepare('sdr10');
    expect(sdr.profile).toMatchObject({
      width: 160,
      height: 96,
      hasAudio: true,
      audioCodec: 'aac',
      audioSampleRate: 48000
    });
    const vfr = await prepare('vfr10');
    expect(vfr.profile.hasAudio).toBe(true);
    expect(vfr.profile.durationSeconds).toBeCloseTo(2, 1);
    const timings = JSON.parse(
      await tool(
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'packet=pts_time',
          '-of',
          'json',
          vfr.file
        ],
        true
      )
    );
    const pts = timings.packets.map((p: { pts_time: string }) => Number(p.pts_time));
    expect(pts.length).toBe(60);
    for (let i = 1; i < pts.length; i++) expect(pts[i] - pts[i - 1]).toBeCloseTo(1 / 30, 5);
  }, 30_000);
  for (const transfer of ['pq', 'hlg'] as const)
    it(`tone maps real ${transfer.toUpperCase()}10 pixels into SDR without washed-out highlights`, async () => {
      const converted = await prepare(`${transfer}10`);
      const data = await pixels(converted.file, converted.workspace);
      const codes = transfer === 'pq' ? [509, 723] : [721, 940];
      for (const [index, code] of codes.entries()) {
        const at = (48 * 160 + (index === 0 ? 60 : 100)) * 3;
        const rgb = [...data.subarray(at, at + 3)];
        rgb.forEach(channel => expect(channel).toBeCloseTo(reference(code, transfer), -1));
        expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThanOrEqual(2);
      }
      expect(data[(48 * 160 + 20) * 3]).toBeLessThan(4);
      const meta = JSON.parse(
        await tool(['-v', 'error', '-show_streams', '-of', 'json', converted.file], true)
      );
      expect(JSON.stringify(meta)).not.toMatch(/smpte2084|arib-std-b67|Mastering display|DOVI/iu);
    }, 30_000);
  it('autorotates hev1 MOV and emits square pixels with no residual display matrix', async () => {
    const rotated = path.join(root, 'rotated.mov');
    await tool([
      '-v',
      'error',
      '-y',
      '-display_rotation',
      '90',
      '-i',
      path.join(fixtures, 'sdr10.mp4'),
      '-c',
      'copy',
      '-tag:v',
      'hev1',
      rotated
    ]);
    const sourceMeta = JSON.parse(
      await tool(['-v', 'error', '-show_streams', '-of', 'json', rotated], true)
    );
    expect(sourceMeta.streams[0].side_data_list).toEqual(
      expect.arrayContaining([expect.objectContaining({ rotation: 90 })])
    );
    const result = await prepare('rotated', rotated);
    expect(result.profile).toMatchObject({ width: 96, height: 160 });
    const meta = JSON.parse(
      await tool(['-v', 'error', '-show_streams', '-of', 'json', result.file], true)
    );
    expect(meta.streams[0].sample_aspect_ratio).toBe('1:1');
    expect(meta.streams[0].side_data_list ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ rotation: 90 })])
    );
  }, 30_000);
  it('rejects a corrupt input without promoting any partial cache output', async () => {
    const workspace = await mkdtemp(path.join(root, 'bad-'));
    const source = path.join(workspace, 'input.mp4');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(source, (await readFile(path.join(fixtures, 'pq10.mp4'))).subarray(0, 100));
    await expect(
      converter.prepare({
        sourceFile: source,
        workspace,
        runId: crypto.randomUUID(),
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ message: 'STITCH_TOOL_FAILED', reason: 'metadata' });
    const entries = await readdir(path.join(root, 'stitcher/compatible-sources'));
    expect(entries.filter(e => e.startsWith('.work-'))).toEqual([]);
    expect(await stat(source).then(s => s.size)).toBe(100);
  });
  it('runs ten native consumers through one encode while the first cancels and deletes its source', async () => {
    const shared = new HevcCompatibility({ root: path.join(root, 'ten-cold') });
    const spy = vi.spyOn(runner, 'runTool');
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const consumers = await Promise.all(
      controllers.map(async () => {
        const workspace = await mkdtemp(path.join(root, 'ten-'));
        const file = path.join(workspace, 'source.mp4');
        await copyFile(path.join(fixtures, 'pq10.mp4'), file);
        return { workspace, file };
      })
    );
    let removed: Promise<void> | undefined;
    try {
      const results = await Promise.allSettled(
        consumers.map((c, index) =>
          shared.prepare({
            sourceFile: c.file,
            workspace: c.workspace,
            runId: crypto.randomUUID(),
            threads: 1,
            signal: controllers[index]!.signal,
            onStage: stage => {
              if (index === 0 && stage === 'converting') {
                controllers[0]!.abort();
                removed = removeTemporaryDirectory(c.workspace);
              }
            }
          })
        )
      );
      await removed;
      expect(results[0]).toMatchObject({
        status: 'rejected',
        reason: { message: 'PROCESS_CANCELED' }
      });
      const completed = results.slice(1).map(r => {
        expect(r.status).toBe('fulfilled');
        if (r.status !== 'fulfilled') throw r.reason;
        return r.value;
      });
      expect(new Set(completed.map(r => r.sourceIdentity)).size).toBe(1);
      expect(spy.mock.calls.filter(([, args]) => args.at(-1) === 'normalized.mp4')).toHaveLength(1);
      for (const r of completed) expect((await stat(r.file)).size).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
  it('creates a fully restitched catalog video from HEVC and invalidates the old negative preparation', async () => {
    const workspace = await mkdtemp(path.join(root, 'delegate-'));
    const source = path.join(fixtures, 'vfr10.mp4');
    const original = await checksum(source);
    const operationId = crypto.randomUUID();
    const progress: number[] = [];
    const defaults = {
      operation: 'restitch' as const,
      startImageIds: [],
      endImageIds: [],
      sourceMode: 'drive' as const,
      automaticEndFrame: true,
      startEnabled: false,
      endEnabled: true,
      fitMode: 'contain' as const,
      finalDurationMode: 'custom' as const,
      customFinalDurationSeconds: 3,
      configured: true,
      updatedAt: '',
      updatedBy: null
    };
    const options = {
      defaults,
      screens: [],
      prepared: {
        materialId: 'video',
        driveVersion: '1',
        detectorVersion: 3,
        detectedStartSeconds: 0,
        detectedEndSeconds: 0,
        profile: null,
        unsupportedReason: 'video-codec',
        preparedAt: ''
      }
    };
    expect(parseRestitchOptions(options)?.prepared).toBeNull();
    const delegate = createRestitchDelegate({
      embedding: () => {
        throw Error('No manual setup');
      },
      imagePathFor: async () => {
        throw Error('No image library');
      },
      threads: () => 1,
      compatibility: converter,
      bodies: new PreparedBodyCache({ root })
    });
    const result = await delegate({
      operationId,
      workspace,
      sourceFile: source,
      sourceSizeBytes: (await stat(source)).size,
      sourceVersion: '1',
      sourceChecksum: null,
      options,
      signal: new AbortController().signal,
      onProgress: value => progress.push(value),
      pausable: () => {}
    });
    const meta = JSON.parse(
      await tool(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.file], true)
    );
    expect(meta.streams[0].codec_name).toBe('h264');
    expect(Number(meta.format.duration)).toBeGreaterThanOrEqual(3);
    expect(result.discovered).toMatchObject({
      detectorVersion: RESTITCH_DETECTOR_VERSION,
      profile: { videoCodec: 'hevc', path: source }
    });
    expect(progress.at(-1)).toBe(100);
    for (let i = 1; i < progress.length; i++)
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(await checksum(source)).toBe(original);
  }, 30_000);
});
