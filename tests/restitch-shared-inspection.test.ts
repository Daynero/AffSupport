import { afterEach, expect, it, vi } from 'vitest';
import type { ImageEmbeddingSettings, SourceProfile } from '@video-compressor/shared';
import {
  createRestitchDelegate,
  clearRestitchInspections
} from '../apps/agent/src/team-bridge/restitch.js';
import type { TeamProcessDelegateInput } from '../apps/agent/src/team-bridge/process.js';
const seams = vi.hoisted(() => ({ probe: vi.fn(), detect: vi.fn() }));
vi.mock('../apps/agent/src/stitcher/probe.js', () => ({ probeSource: seams.probe }));
vi.mock('../apps/agent/src/stitcher/plan.js', async original => ({
  ...(await original<typeof import('../apps/agent/src/stitcher/plan.js')>()),
  detectStitching: seams.detect
}));
const profile = (path: string): SourceProfile =>
  ({
    path,
    sizeBytes: 1000,
    modifiedAtMs: 1,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    profile: 'High',
    level: 40,
    width: 1080,
    height: 1080,
    pixelFormat: 'yuv420p',
    colorRange: 'tv',
    frameRate: 30,
    variableFrameRate: false,
    videoTimescale: 15360,
    durationSeconds: 10,
    hasAudio: false,
    keyframeTimes: [0, 1, 9]
  }) as SourceProfile;
const input = (id: string, signal = new AbortController().signal): TeamProcessDelegateInput => ({
  operationId: id,
  teamId: 'team',
  workspace: `/unused/${id}`,
  sourceFile: `/unused/${id}/source.mp4`,
  sourceChecksum: 'a'.repeat(32),
  sourceSizeBytes: 1000,
  sourceVersion: '1',
  signal,
  onProgress: () => {},
  pausable: () => {},
  options: {
    defaults: {
      operation: 'unstitch',
      startImageIds: [],
      endImageIds: [],
      fitMode: 'contain',
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 60,
      startEnabled: false,
      endEnabled: false,
      sourceMode: 'drive',
      configured: true,
      updatedAt: '',
      updatedBy: null
    }
  }
});
function delegate() {
  const pipeline = vi.fn(async () => ({ ok: false as const, error: 'STITCH_CANCELLED' as const }));
  return {
    pipeline,
    run: createRestitchDelegate({
      embedding: () => ({ startImages: [], endImages: [] }) as unknown as ImageEmbeddingSettings,
      imagePathFor: async () => null,
      pipeline
    })
  };
}
afterEach(() => {
  clearRestitchInspections();
  vi.resetAllMocks();
});
it('shares cold inspection for verified bytes and restores each consumer source path', async () => {
  let complete!: () => void;
  seams.probe.mockImplementation(async (file: string) => {
    await new Promise<void>(r => {
      complete = r;
    });
    return { ok: true, value: profile(file) };
  });
  seams.detect.mockResolvedValue({ startSeconds: 1, endSeconds: 1, adjustedByUser: false });
  const { run, pipeline } = delegate();
  const jobs = ['a', 'b', 'c', 'd'].map(id => run(input(id)).catch(e => e));
  await vi.waitFor(() => expect(seams.probe).toHaveBeenCalledOnce());
  complete();
  await Promise.all(jobs);
  expect(seams.probe).toHaveBeenCalledOnce();
  expect(seams.detect).toHaveBeenCalledOnce();
  expect(pipeline).toHaveBeenCalledTimes(4);
  const requests = pipeline.mock.calls as unknown as Array<
    [{ request: { profile: SourceProfile } }]
  >;
  expect(requests.map(([r]) => r.request.profile.path).sort()).toEqual(
    ['a', 'b', 'c', 'd'].map(id => input(id).sourceFile)
  );
});
it('an aborted waiting consumer exits without canceling the inspection producer', async () => {
  let complete!: () => void;
  seams.probe.mockImplementation(async (file: string) => {
    await new Promise<void>(r => {
      complete = r;
    });
    return { ok: true, value: profile(file) };
  });
  seams.detect.mockResolvedValue({ startSeconds: 1, endSeconds: 1, adjustedByUser: false });
  const { run, pipeline } = delegate();
  const first = run(input('producer')).catch(e => e);
  const stop = new AbortController();
  const waiter = run(input('waiter', stop.signal)).catch(e => e);
  stop.abort(new Error('consumer left'));
  expect((await waiter).message).toBe('consumer left');
  complete();
  await first;
  expect(pipeline).toHaveBeenCalledOnce();
});
it('retries inspection in a healthy consumer when the first producer fails', async () => {
  seams.probe.mockRejectedValueOnce(new Error('producer stopped'));
  seams.probe.mockImplementation(async (file: string) => ({ ok: true, value: profile(file) }));
  seams.detect.mockResolvedValue({ startSeconds: 1, endSeconds: 1, adjustedByUser: false });
  const { run, pipeline } = delegate();
  await Promise.all([run(input('a')).catch(e => e), run(input('b')).catch(e => e)]);
  expect(seams.probe).toHaveBeenCalledTimes(2);
  expect(pipeline).toHaveBeenCalledOnce();
});
